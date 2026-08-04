// End-to-end test: drive EBMLRemuxer with a synthetic Matroska file and check
// the fragmented-MP4 it produces. Run with plain node from the repo root.
//
// This exercises the parts unit tests can't reach: EBML parsing, per-cluster
// frame collection, track demultiplexing and cluster->media-segment handoff.

var assert = require('assert');
var stream = require('readable-stream');

// ------------------------------------------------------------------ globals
// ebml-remuxer.js is browser code; stand up the handful of MEGA/DOM globals it
// touches at load time.
var supported = /mp4/;
global.localStorage = {};
global.window = {d: 0};
global.d = 0;
global.MediaSource = {
    isTypeSupported: function(type) {
        return supported.test(type);
    }
};
global.vsNT = function(cb) {
    queueMicrotask(cb);
};
global.tryCatch = function(fn, onerr) {
    return function() {
        try {
            return fn.apply(this, arguments);
        }
        catch (ex) {
            if (!onerr) {
                throw ex;
            }
            onerr(ex);
        }
    };
};
global.lazy = function(obj, prop, fn) {
    Object.defineProperty(obj, prop, {
        configurable: true,
        get: function() {
            var value = fn.call(this);
            Object.defineProperty(this, prop, {value: value});
            return value;
        }
    });
};

global.mega = {ipcc: 'NZ', intl: {locale: 'en'}};

var Box = require('mp4-box-encoding');
Box.boxes = Box.boxes || require('mp4-box-encoding/boxes');

// videostream.js loads both remuxers, so mp4-remuxer's box registrations
// (notably the hvcC decoder behind the HEVC codec string) are always present
// in the bundle. Load it here too so this test matches production.
require('./mp4-remuxer.js');

var EBMLRemuxer = require('./ebml-remuxer.js');

function ok(name) {
    console.log('  ok - ' + name);
}

// ------------------------------------------------------------- EBML writer
function vint(n) {
    if (n < 0x7f) {
        return Buffer.from([0x80 | n]);
    }
    if (n < 0x3fff) {
        return Buffer.from([0x40 | (n >> 8), n & 0xff]);
    }
    if (n < 0x1fffff) {
        return Buffer.from([0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff]);
    }
    return Buffer.from([0x10 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function el(id, payload) {
    if (Array.isArray(payload)) {
        payload = Buffer.concat(payload);
    }
    var idb = Buffer.from(id, 'hex');
    return Buffer.concat([idb, vint(payload.length), payload]);
}

function uint(v) {
    var out = [];
    do {
        out.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    while (v > 0);
    return Buffer.from(out);
}

function dbl(v) {
    var b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    return b;
}

function simpleBlock(track, timecode, keyframe, payload) {
    var head = Buffer.alloc(4);
    head.writeUInt8(0x80 | track, 0);
    head.writeInt16BE(timecode, 1);
    head.writeUInt8(keyframe ? 0x80 : 0, 3);
    return el('a3', [head, payload]);
}

var AVCC = Buffer.from([
    0x01, 0x64, 0x00, 0x29, 0xff, 0xe1, 0x00, 0x04,
    0x67, 0x64, 0x00, 0x29, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80
]);
var ASC = Buffer.from([0x12, 0x10]); // AAC-LC 44.1kHz stereo

// A 23-byte HEVCDecoderConfigurationRecord: Main profile, level 9.3.
var HVCC = Buffer.from([
    0x01,                                            // configurationVersion
    0x01,                                            // profile_space/tier/profile_idc = Main
    0x60, 0x00, 0x00, 0x00,                          // profile_compatibility_flags
    0x90, 0x00, 0x00, 0x00, 0x00, 0x00,              // constraint_indicator_flags
    93,                                              // general_level_idc
    0xf0, 0x00,                                      // min_spatial_segmentation_idc
    0xfc,                                            // parallelismType
    0xfd,                                            // chromaFormat 4:2:0
    0xf8,                                            // bitDepthLumaMinus8 = 0
    0xf8,                                            // bitDepthChromaMinus8 = 0
    0x00, 0x00,                                      // avgFrameRate
    0x0f,                                            // lengthSizeMinusOne = 3
    0x00                                             // numOfArrays
]);

/**
 * @param {String} videoCodec Matroska CodecID for the video track
 * @param {String} audioCodec Matroska CodecID for the audio track
 * @returns {Buffer} a small but structurally valid .mkv
 */
function buildMkv(videoCodec, audioCodec, opts) {
    opts = opts || {};

    // ContentEncodings > ContentEncoding > ContentCompression
    var encodings = null;
    if (opts.strip) {
        encodings = el('6d80', el('6240', el('5034', [
            el('4254', uint(3)),        // ContentCompAlgo: header stripping
            el('4255', opts.strip)      // ContentCompSettings
        ])));
    }
    else if (opts.zlib) {
        // ContentCompAlgo defaults to 0 (zlib) when the element is absent.
        encodings = el('6d80', el('6240', el('5034', [])));
    }

    var info = el('1549a966', [
        el('2ad7b1', uint(1000000)),  // TimecodeScale: 1ms
        el('4489', dbl(400))          // Duration
    ]);

    var tracks = el('1654ae6b', [
        el('ae', [
            el('d7', uint(1)),                            // TrackNumber
            el('83', uint(1)),                            // TrackType: video
            el('86', Buffer.from(videoCodec, 'ascii')),   // CodecID
            el('63a2', videoCodec.indexOf('HEVC') > 0 ? HVCC : AVCC), // CodecPrivate
            el('23e383', uint(40000000)),                 // DefaultDuration 40ms
            el('e0', [el('b0', uint(1920)), el('ba', uint(1080))])
        ].concat(encodings ? [encodings] : [])),
        el('ae', [
            el('d7', uint(2)),
            el('83', uint(2)),                            // TrackType: audio
            el('86', Buffer.from(audioCodec, 'ascii')),
            el('63a2', ASC),
            el('e1', [el('9f', uint(2)), el('b5', dbl(44100))])
        ])
    ]);

    // Cluster 0 stores video in decode order I,P,B,B for presentation
    // 0,40,80,120 -- the reordering case that needs DTS derivation.
    var cluster0 = el('1f43b675', [
        el('e7', uint(0)),
        simpleBlock(1, 0, true, Buffer.from([0x11, 0x11, 0x11, 0x11])),
        simpleBlock(1, 120, false, Buffer.from([0x22, 0x22])),
        simpleBlock(1, 40, false, Buffer.from([0x33, 0x33])),
        simpleBlock(1, 80, false, Buffer.from([0x44, 0x44])),
        simpleBlock(2, 0, true, Buffer.from([0xa0, 0xa0])),
        simpleBlock(2, 23, true, Buffer.from([0xa1, 0xa1]))
    ]);

    var cluster1 = el('1f43b675', [
        el('e7', uint(160)),
        simpleBlock(1, 0, true, Buffer.from([0x55, 0x55, 0x55])),
        simpleBlock(1, 40, false, Buffer.from([0x66, 0x66])),
        simpleBlock(2, 0, true, Buffer.from([0xa2, 0xa2]))
    ]);

    var segment = el('18538067', [info, tracks, cluster0, cluster1]);
    var ebml = el('1a45dfa3', el('4282', Buffer.from('matroska', 'ascii')));

    return Buffer.concat([ebml, segment]);
}

function mockFile(buf) {
    return {
        filesize: buf.length,
        createReadStream: function(opts) {
            var pos = (opts && opts.start) | 0;
            var r = new stream.Readable({
                read: function() {}
            });
            queueMicrotask(function() {
                while (pos < buf.length) {
                    var end = Math.min(pos + 512, buf.length);
                    r.push(buf.slice(pos, end));
                    pos = end;
                }
                r.push(null);
            });
            return r;
        }
    };
}

/**
 * Run the remuxer over a synthetic file and collect everything it emits.
 * @param {Buffer} mkv the file bytes
 * @returns {Promise} {data, segments}
 */
function run(mkv) {
    return new Promise(function(resolve, reject) {
        var muxer = new EBMLRemuxer(mockFile(mkv));

        muxer.on('error', reject);
        muxer.once('ready', function(data) {
            var streams = muxer.seek(0);
            var segments = streams.map(function() {
                return [];
            });
            var pending = streams.length;

            streams.forEach(function(s, i) {
                s.on('data', function(chunk) {
                    segments[i].push(chunk);
                });
                s.on('end', function() {
                    if (!--pending) {
                        resolve({data: data, segments: segments, muxer: muxer});
                    }
                });
            });
        });

        setTimeout(function() {
            reject(new Error('timed out'));
        }, 5000).unref();
    });
}

/**
 * Walk a concatenated moof+mdat stream, returning one entry per fragment.
 * @param {Buffer} buf the media segment bytes
 * @returns {Array} fragment descriptors
 */
function parseFragments(buf) {
    var out = [];
    var ptr = 0;

    while (ptr < buf.length) {
        var moofLen = buf.readUInt32BE(ptr);
        assert.strictEqual(buf.toString('ascii', ptr + 4, ptr + 8), 'moof', 'expected a moof');

        var trunAt = buf.indexOf('trun', ptr, 'ascii');
        var tfdtAt = buf.indexOf('tfdt', ptr, 'ascii');
        assert.ok(trunAt > ptr && trunAt < ptr + moofLen, 'trun inside moof');

        var mdatLen = buf.readUInt32BE(ptr + moofLen);
        assert.strictEqual(buf.toString('ascii', ptr + moofLen + 4, ptr + moofLen + 8), 'mdat', 'expected an mdat');

        var count = buf.readUInt32BE(trunAt + 8);
        var samples = [];
        for (var i = 0; i < count; i++) {
            var at = trunAt + 16 + i * 16;
            samples.push({
                duration: buf.readUInt32BE(at),
                size: buf.readUInt32BE(at + 4),
                flags: buf.readUInt32BE(at + 8),
                cts: buf.readInt32BE(at + 12)
            });
        }

        out.push({
            baseMediaDecodeTime: buf.readUInt32BE(tfdtAt + 8),
            dataOffset: buf.readInt32BE(trunAt + 12),
            moofLen: moofLen,
            mdatLen: mdatLen,
            samples: samples
        });

        ptr += moofLen + mdatLen;
    }
    return out;
}

// =========================================================================
Promise.resolve()
    .then(function() {
        // --- H.264 + AAC: the case the whole ticket exists for -------------
        supported = /mp4/;
        return run(buildMkv('V_MPEG4/ISO/AVC', 'A_AAC'));
    })
    .then(function(res) {
        assert.strictEqual(res.data.length, 2, 'video and audio must be separate tracks/SourceBuffers');
        assert.strictEqual(res.data[0].mime, 'video/mp4; codecs="avc1.640029"');
        assert.strictEqual(res.data[1].mime, 'audio/mp4; codecs="mp4a.40.2"');
        assert.strictEqual(res.muxer._hasVideo, 'avc1.640029');
        assert.strictEqual(res.muxer._hasAudio, 'mp4a.40.2');
        assert.strictEqual(res.muxer._hasUnsupportedAudio, false);

        // Each init segment must be a real ftyp+moov.
        var ftyp = Box.decode(res.data[0].init, 0);
        assert.strictEqual(ftyp.type, 'ftyp');
        var moov = Box.decode(res.data[0].init, ftyp.length);
        assert.strictEqual(moov.traks[0].mdia.minf.stbl.stsd.entries[0].type, 'avc1');
        ok('MKV H.264+AAC -> two fMP4 SourceBuffers with correct codec strings');

        // Fragments are no longer one-per-cluster: frames are held in a reorder
        // window spanning cluster boundaries and accumulated until they make up
        // a whole fragment, so this short file yields a single one.
        var video = parseFragments(Buffer.concat(res.segments[0]));
        var vs = video.reduce(function(a, f) { return a.concat(f.samples); }, []);

        assert.strictEqual(vs.length, 6, 'every video frame from both clusters must come out');

        // Storage order across the two clusters is PTS 0,120,40,80 then 160,200.
        // Decode order is those sorted, and cts must rebuild the presentation order.
        assert.strictEqual(video[0].baseMediaDecodeTime, 0);
        assert.deepStrictEqual(vs.map(function(s) { return s.cts; }), [0, 80, -40, -40, 0, 0],
            'composition offsets must reconstruct the presentation order');
        assert.deepStrictEqual(vs.map(function(s) { return s.size; }), [4, 2, 2, 2, 3, 2],
            'sample sizes must match the block payloads');
        assert.strictEqual(vs[0].flags, 0x2000000, 'first sample is a sync sample');
        assert.strictEqual(vs[1].flags, 0x1010000, 'the rest are not');
        assert.strictEqual(video[0].dataOffset, video[0].moofLen + 8,
            'trun.dataOffset points into the mdat');

        // Decode timestamps must never run backwards, across clusters included.
        var dts = 0;
        for (var v = 0; v < vs.length; v++) {
            assert.ok(vs[v].duration > 0, 'every sample needs a duration');
            dts += vs[v].duration;
        }
        ok('cross-cluster reordering: DTS/CTS, tfdt, sizes, sync flags');

        var audio = parseFragments(Buffer.concat(res.segments[1]));
        var as = audio.reduce(function(a, f) { return a.concat(f.samples); }, []);
        assert.strictEqual(as.length, 3, 'audio demultiplexed out of the same clusters');
        assert.strictEqual(as[0].duration, 23, 'duration from the next sample dts');
        ok('audio track demultiplexed from the same clusters');
    })
    .then(function() {
        // --- H.264 + DTS: the headline case. Video must still play --------
        supported = /mp4/;
        return run(buildMkv('V_MPEG4/ISO/AVC', 'A_DTS'));
    })
    .then(function(res) {
        assert.strictEqual(res.data.length, 1, 'DTS track must be dropped, not fatal');
        assert.strictEqual(res.data[0].mime, 'video/mp4; codecs="avc1.640029"');
        assert.strictEqual(res.muxer._hasAudio, false);
        assert.strictEqual(res.muxer._hasUnsupportedAudio, 'A_DTS',
            'must be reported so the player can show l[19060]');

        var video = parseFragments(Buffer.concat(res.segments[0]));
        var count = video.reduce(function(a, f) { return a + f.samples.length; }, 0);
        assert.strictEqual(count, 6, 'video is unaffected by the dropped audio');
        ok('MKV H.264+DTS -> video plays, DTS reported as unsupported audio');
    })
    .then(function() {
        // --- HEVC + AC-3 ---------------------------------------------------
        supported = /mp4/;
        return run(buildMkv('V_MPEGH/ISO/HEVC', 'A_AC3'));
    })
    .then(function(res) {
        assert.strictEqual(res.data.length, 1);
        assert.ok(/^video\/mp4; codecs="hvc1\./.test(res.data[0].mime), 'HEVC codec string: ' + res.data[0].mime);
        assert.strictEqual(res.muxer._hasUnsupportedAudio, 'A_AC3');
        ok('MKV HEVC+AC-3 -> hvc1 video, AC-3 reported unsupported');
    })
    .then(function() {
        // --- Header stripping (test3/test6 in the Matroska suite) ----------
        // Two bytes are removed from every frame and stored once on the track;
        // the remuxer has to put them back or every sample is short by 2.
        supported = /mp4/;
        return run(buildMkv('V_MPEG4/ISO/AVC', 'A_AAC', {strip: Buffer.from([0xde, 0xad])}));
    })
    .then(function(res) {
        var video = parseFragments(Buffer.concat(res.segments[0]));
        var sizes = video.reduce(function(a, f) { return a.concat(f.samples); }, [])
            .map(function(s) { return s.size; });

        // Payloads were 4,2,2,2 then 3,2 bytes; each gains the 2 stripped bytes.
        assert.deepStrictEqual(sizes, [6, 4, 4, 4, 5, 4],
            'stripped header bytes must be prepended to every frame');

        var mdat = Buffer.concat(res.segments[0]).slice(video[0].dataOffset, video[0].dataOffset + 6);
        assert.strictEqual(mdat.toString('hex'), 'dead11111111', 'frame must start with the stripped bytes');
        ok('header stripping: ContentCompAlgo 3 bytes restored');
    })
    .then(function() {
        // --- Compression we cannot undo must be refused, not fed as garbage -
        supported = /mp4/;
        return run(buildMkv('V_MPEG4/ISO/AVC', 'A_AAC', {zlib: true})).then(
            function(res) {
                assert.strictEqual(res.data.length, 0, 'zlib-compressed tracks must not be offered');
            },
            function(err) {
                assert.ok(/no playable tracks/.test(err.message), 'expected refusal, got: ' + err.message);
            });
    })
    .then(function() {
        ok('zlib-compressed tracks refused rather than emitted corrupt');
    })
    .then(function() {
        // --- Regression: a real WebM must still take the passthrough ------
        supported = /webm/;
        return run(buildMkv('V_VP9', 'A_OPUS'));
    })
    .then(function(res) {
        assert.strictEqual(res.muxer._fmp4, false, 'VP9+Opus must NOT be remuxed');
        assert.strictEqual(res.data.length, 1, 'passthrough uses a single combined SourceBuffer');
        assert.strictEqual(res.data[0].mime, 'video/webm; codecs="vp9,opus"');

        // Passthrough pushes raw EBML clusters, never a moof.
        var out = Buffer.concat(res.segments[0]);
        assert.strictEqual(out.indexOf('moof', 0, 'ascii'), -1, 'passthrough output must contain no fMP4 boxes');
        ok('regression: VP9+Opus still uses the raw-EBML passthrough');
    })
    .then(function() {
        // --- media time <-> file time round-trip -----------------------------
        // Closing a hole makes media time run ahead of file time. _findCluster
        // is asked in media time but indexes cues by file time, and must report
        // its fixup back in media time -- getting that wrong makes _tryPump()
        // see a permanent discrepancy and coerce backwards on every seek, which
        // walked playback to zero.
        var m = Object.create(EBMLRemuxer.prototype);
        m._timescale = 1000;
        m._skipped = [{from: 1001, to: 2000}];   // a 999ms hole at 1.001s

        assert.strictEqual(m._fileTimeFor(0.5), 0.5, 'before the hole: unchanged');
        assert.strictEqual(m._skippedBefore(500), 0);

        // After the hole, media time 1.5s is file time 2.499s.
        assert.strictEqual(m._fileTimeFor(1.5), 2.499, 'after the hole: shifted forward');
        assert.strictEqual(m._skippedBefore(2499), 999);

        [0, 0.25, 1.0, 1.5, 10, 35.5].forEach(function(mediaTime) {
            var fileTime = m._fileTimeFor(mediaTime);
            var back = fileTime - m._skippedBefore(fileTime * 1000) / 1000;
            assert.ok(Math.abs(back - mediaTime) < 1e-9,
                'round-trip failed at ' + mediaTime + ' (file ' + fileTime + ' -> ' + back + ')');
        });

        // Re-reading the same damaged region must not widen the total.
        m._recordSkip(1001, 2000);
        m._recordSkip(1200, 1800);
        assert.strictEqual(m._skippedBefore(Infinity), 999, 'overlapping skips must merge, not accumulate');
        ok('media/file time round-trip and idempotent hole tracking');
    })
    .then(function() {
        console.log('\nAll ebml-remuxer end-to-end checks passed.');
    })
    .catch(function(ex) {
        console.error('\nFAILED:', ex && ex.message);
        console.error(ex && ex.stack);
        process.exit(1);
    });
