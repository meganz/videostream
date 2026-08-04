// Run real .mkv files through EBMLRemuxer under node and report what comes out.
//   node test-real-files.js <dir-with-mkvs> [file.mkv ...]
// Reproduces browser playback faults offline: how much of the timeline the
// remuxer actually produces, and where it stops.

var fs = require('fs');
var path = require('path');
var stream = require('readable-stream');

var supported = /mp4|webm/;
global.localStorage = {};
global.window = {d: 0};
global.d = 0;
global.MediaSource = {isTypeSupported: function(t) { return supported.test(t); }};
global.vsNT = function(cb) { queueMicrotask(cb); };
global.tryCatch = function(fn, onerr) {
    return function() {
        try { return fn.apply(this, arguments); }
        catch (ex) { if (!onerr) { throw ex; } onerr(ex); }
    };
};
global.lazy = function(obj, prop, fn) {
    Object.defineProperty(obj, prop, {
        configurable: true,
        get: function() {
            var v = fn.call(this);
            Object.defineProperty(this, prop, {value: v});
            return v;
        }
    });
};
global.mega = {ipcc: 'NZ', intl: {locale: 'en'}};

var Box = require('mp4-box-encoding');
Box.boxes = Box.boxes || require('mp4-box-encoding/boxes');
require('./mp4-remuxer.js');
var EBMLRemuxer = require('./ebml-remuxer.js');

function mockFile(buf) {
    return {
        filesize: buf.length,
        createReadStream: function(opts) {
            var pos = (opts && opts.start) | 0;
            var r = new stream.Readable({read: function() {}});
            var pump = function() {
                if (r.destroyed || pos >= buf.length) {
                    if (!r.destroyed) { r.push(null); }
                    return;
                }
                var end = Math.min(pos + 65536, buf.length);
                r.push(buf.slice(pos, end));
                pos = end;
                setTimeout(pump, 0);
            };
            setTimeout(pump, 0);
            return r;
        }
    };
}

/** Walk concatenated moof+mdat, returning per-fragment stats. */
function fragments(buf) {
    var out = [];
    var ptr = 0;

    while (ptr + 8 <= buf.length) {
        var moofLen = buf.readUInt32BE(ptr);
        if (buf.toString('ascii', ptr + 4, ptr + 8) !== 'moof' || moofLen <= 0) {
            out.push({BROKEN_AT: ptr});
            break;
        }
        var trunAt = buf.indexOf('trun', ptr, 'ascii');
        var tfdtAt = buf.indexOf('tfdt', ptr, 'ascii');
        var count = buf.readUInt32BE(trunAt + 8);
        var base = buf.readUInt32BE(tfdtAt + 8);
        var dur = 0;
        // The browser buffers by presentation time, not decode time, so track
        // pts = dts + cts as well -- with B-frames the two differ.
        var minPts = Infinity;
        var maxPtsEnd = -Infinity;

        for (var i = 0; i < count; i++) {
            var at = trunAt + 16 + i * 16;
            var sampleDur = buf.readUInt32BE(at);
            var pts = base + dur + buf.readInt32BE(at + 12);

            if (pts < minPts) {
                minPts = pts;
            }
            if (pts + sampleDur > maxPtsEnd) {
                maxPtsEnd = pts + sampleDur;
            }
            dur += sampleDur;
        }
        out.push({dts: base, samples: count, duration: dur, ptsFrom: minPts, ptsTo: maxPtsEnd});
        ptr += moofLen + buf.readUInt32BE(ptr + moofLen);
    }
    return out;
}

function run(file) {
    return new Promise(function(resolve) {
        var buf = fs.readFileSync(file);
        var name = path.basename(file);
        var report = {file: name, size: buf.length, errors: [], tracks: null};
        var muxer = new EBMLRemuxer(mockFile(buf));
        var done = function() {
            if (!report.finished) { report.finished = true; resolve(report); }
        };

        muxer.on('error', function(err) {
            report.errors.push(String(err && err.message || err));
            done();
        });

        muxer.once('ready', function(data) {
            report.tracks = data.map(function(t) { return t.mime; });
            report.fmp4 = muxer._fmp4;
            report.unsupportedAudio = muxer._hasUnsupportedAudio;
            report.cues = muxer._seekTable ? muxer._seekTable.length : 0;
            report.playtime = muxer._initSegment.playtime;
            report.timescale = Math.round(1e9 / muxer._initSegment.timecodeScale);

            var streams = muxer.seek(0);
            var chunks = streams.map(function() { return []; });
            var pending = streams.length;

            streams.forEach(function(s, i) {
                s.on('data', function(c) { chunks[i].push(c); });
                s.on('end', function() {
                    if (!--pending) {
                        report.perTrack = chunks.map(function(list, k) {
                            var all = Buffer.concat(list);
                            var f = muxer._fmp4 ? fragments(all) : [];
                            var last = f[f.length - 1] || {};
                            return {
                                mime: report.tracks[k],
                                bytes: all.length,
                                fragments: f.length,
                                samples: f.reduce(function(a, x) { return a + (x.samples | 0); }, 0),
                                firstDts: f.length ? f[0].dts : null,
                                lastDts: last.dts === undefined ? null : last.dts,
                                endsAtSec: last.dts === undefined ? null
                                    : +(((last.dts + (last.duration | 0)) / report.timescale).toFixed(2)),
                                spans: f.map(function(x) { return [x.dts, x.dts + (x.duration | 0)]; }),
                                ptsSpans: f.map(function(x) { return [x.ptsFrom, x.ptsTo]; }),
                                broken: f.filter(function(x) { return x.BROKEN_AT !== undefined; }).length
                            };
                        });
                        done();
                    }
                });
            });
        });

        setTimeout(function() { report.errors.push('TIMEOUT'); done(); }, 120000).unref();
    });
}

(async () => {
    var dir = process.argv[2];
    var files = process.argv.slice(3);
    if (!files.length) {
        files = fs.readdirSync(dir).filter(function(f) { return /\.mkv$/i.test(f); });
    }
    for (var i = 0; i < files.length; i++) {
        var r = await run(path.join(dir, files[i]));
        console.log('\n=== ' + r.file + ' (' + r.size + ' bytes) ===');
        console.log('  fmp4=%s cues=%s playtime=%ss timescale=%s', r.fmp4, r.cues,
            r.playtime === undefined ? '?' : r.playtime, r.timescale);
        console.log('  tracks:', r.tracks);
        if (r.unsupportedAudio) { console.log('  unsupportedAudio:', r.unsupportedAudio); }
        if (r.errors.length) { console.log('  ERRORS:', r.errors); }
        (r.perTrack || []).forEach(function(t) {
            console.log('   -', t.mime);
            console.log('     fragments=%s samples=%s bytes=%s dts %s..%s -> ends at %ss%s',
                t.fragments, t.samples, t.bytes, t.firstDts, t.lastDts, t.endsAtSec,
                t.broken ? '  *** BROKEN FRAGMENT ***' : '');

            // A hole in the decode timeline is what makes the browser stall
            // forever at that point, so call them out explicitly.
            var gaps = [];
            for (var g = 1; g < t.spans.length; g++) {
                // A hole is where the next fragment starts after the previous
                // one ended -- not merely a long fragment.
                var hole = t.spans[g][0] - t.spans[g - 1][1];
                if (hole > 0.05 * r.timescale) {
                    gaps.push(t.spans[g - 1][1] + '..' + t.spans[g][0]
                        + ' (' + (hole / r.timescale).toFixed(2) + 's)');
                }
            }
            console.log('     DTS GAPS: %s', gaps.length ? gaps.join(', ') : 'none');

            // The one that actually matters: holes on the presentation
            // timeline are what the browser reports as buffered gaps.
            // Overlaps matter as much as holes: a fragment that starts before
            // the previous one ended runs backwards, and the browser turns that
            // into a hole in its buffered range. Reporting only positive
            // differences hid exactly that bug.
            var pgaps = [];
            var overlaps = [];
            for (var p = 1; p < t.ptsSpans.length; p++) {
                var phole = t.ptsSpans[p][0] - t.ptsSpans[p - 1][1];
                if (phole > 0.05 * r.timescale) {
                    pgaps.push(t.ptsSpans[p - 1][1] + '..' + t.ptsSpans[p][0]
                        + ' (' + (phole / r.timescale).toFixed(3) + 's)');
                }
                else if (phole < 0) {
                    overlaps.push(t.ptsSpans[p - 1][1] + '>' + t.ptsSpans[p][0]
                        + ' (' + (-phole / r.timescale).toFixed(3) + 's)');
                }
            }
            console.log('     PTS GAPS: %s', pgaps.length ? pgaps.join(', ') : 'none');
            console.log('     PTS OVERLAPS: %s', overlaps.length ? overlaps.join(', ') : 'none');
            console.log('     first spans dts: %s', t.spans.slice(0, 8).map(function(s) {
                return s[0] + '-' + s[1];
            }).join(' | '));
            console.log('     first spans pts: %s', t.ptsSpans.slice(0, 8).map(function(s) {
                return s[0] + '-' + s[1];
            }).join(' | '));
        });
    }
})();

