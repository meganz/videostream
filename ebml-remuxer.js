'use strict';

var inherits = require('inherits');
var Buffer = require('buffer').Buffer;
var stream = require('readable-stream');
var EventEmitter = require('events').EventEmitter;
var EBMLDecoder = require('ebml/lib/ebml/decoder');
var mkv = require('./mkv-fmp4');

module.exports = EBMLRemuxer;

// Seconds of media per fMP4 fragment; mirrors mp4-remuxer.js. Halving it was
// tried to cut time-to-first-frame and measurably did not help, so it stays in
// step with the MP4 path rather than diverging for no gain.
var MIN_FRAGMENT_DURATION = 1;

// Video frames kept in hand before their decode time is fixed. Must exceed the
// stream's reorder depth: H.264 typically needs 2-3, HEVC B-pyramids 4-5.
// Comfortably above both, and the cost is only a little latency at startup.
var REORDER_DEPTH = 16;


var DEBUG = localStorage.vsd | 0;
var DEBUG_INFO = DEBUG || window.d;
var DEBUG_ALL = DEBUG > 3;
var DEBUG_TRACE = DEBUG > 2;
var DEBUG_VERBOSE = DEBUG > 1;

if (DEBUG_TRACE) {
    var tmp = function EBMLDecoder() {
        this.$etup();
    };

    createStream(tmp, EBMLDecoder);
    EBMLDecoder = tmp;
}

/**
 * Receives raw data and sends back webm media segments.
 * @param {Object} file The file instance to get raw data from
 * @constructor
 */
function EBMLRemuxer(file) {
    var self = this;
    this.$etup();

    this._file = file;
    this._tracks = [];
    this._seekTime = -1;
    this._hasVideo = false;
    this._hasAudio = false;
    this._seekTable = false;
    this._seekTimeFixup = -1;
    this._initSegment = false;
    this._hasUnsupportedAudio = false;

    // Set once we fall out of the raw-EBML passthrough and start remuxing into
    // fragmented MP4; see _setupFmp4().
    this._fmp4 = false;
    this._trackMap = null;
    this._clusterReader = null;

    // Media skipped by a resync leaves a hole the browser stalls on forever, so
    // everything after it is pulled back over the hole. Holes are stored as
    // file-time ranges rather than a running total: seeking makes us re-read the
    // same damaged region, and a running total would count it again every time,
    // shrinking the timeline further on each pass.
    this._skipped = [];
    this._timescale = 1000;
    this._resyncGap = false;

    this._createReader(0, 'segment', function(segment) {
        this.destroy();

        // The reader is already gone by this point, so its own error plumbing
        // can no longer carry anything thrown in here -- it would be swallowed
        // and the muxer would just hang. Hand failures to the muxer directly.
        try {
            self.setInitSegment(segment);
        }
        catch (ex) {
            self.destroy(ex);
        }
    });
}

createStream(EBMLRemuxer, EventEmitter, function() {
    if (this._clusterReader) {
        this._clusterReader.destroy();
        this._clusterReader = null;
    }
});

EBMLRemuxer.prototype.emitInitSegment = function(segment) {
    var tracks = segment.Tracks;

    if (DEBUG_INFO) {
        console.log('initSegment', segment, [this]);
    }

    if (!tracks) {
        return this.destroy(new Error('Unsupported media format.'));
    }

    // Prefer the historic raw-EBML passthrough whenever the file really is a
    // WebM in a .mkv wrapper -- it is battle-tested and skips remuxing
    // entirely, so files that play today keep taking the exact same path.
    var data = this._setupPassthrough(tracks, segment) || this._setupFmp4(tracks, segment);

    if (!data) {
        return this.destroy(new Error('no playable tracks'));
    }

    this._buildSeekTable(segment);
    this._initSegment = segment;
    this.emit('ready', data);
};

/**
 * Build the fragmented-MP4 track set for containers the passthrough can't take
 * (H.264/HEVC video, AAC/MP3/FLAC audio, ...).
 *
 * Audio codecs no browser can decode through MSE -- DTS, AC-3, E-AC-3, TrueHD
 * -- deliberately fall through to `_hasUnsupportedAudio`, so the video still
 * plays and the player shows l[19060] "Unsupported audio codec (%1)".
 *
 * @param {Array} tracks TrackEntry list
 * @param {Object} segment parsed init segment
 * @returns {Array|false} per-track {mime, init}, or false if nothing is playable
 */
EBMLRemuxer.prototype._setupFmp4 = function(tracks, segment) {
    var self = this;
    var scale = segment.timecodeScale;
    var timescale = Math.round(1e9 / scale);
    var data = [];

    self._timescale = timescale;

    self._trackMap = Object.create(null);

    for (var i = 0; i < tracks.length; i++) {
        var entry = tracks[i];
        var type = entry.TrackType;

        if (type === 1 ? self._hasVideo : !(type === 2) || self._hasAudio) {
            continue;
        }

        var codecId = String(entry.CodecID);
        var map = mkv.lookupCodec(codecId, type);

        if (!map) {
            if (DEBUG_INFO) {
                console.debug('Track%s: cannot carry %s in fMP4.', entry.TrackNumber, codecId);
            }
            if (type === 2) {
                self._hasUnsupportedAudio = codecId;
            }
            continue;
        }

        var encoding = readContentEncoding(entry);

        if (encoding === false) {
            // zlib/bzip/lzo compression or encryption -- we cannot undo it, and
            // emitting the raw frames would just feed the decoder garbage.
            if (DEBUG_INFO) {
                console.debug('Track%s: unsupported content encoding.', entry.TrackNumber);
            }
            if (type === 2) {
                self._hasUnsupportedAudio = codecId;
            }
            continue;
        }

        var video = entry.Video || false;
        var audio = entry.Audio || false;
        var rate = Math.round(audio.SamplingFrequency || 48000);
        var track = {
            map: map,
            type: type,
            sequence: 1,
            timescale: timescale,
            language: 0x55c4, // 'und'
            number: entry.TrackNumber,
            trackId: data.length + 1,
            codecPrivate: entry.CodecPrivate,
            width: video.PixelWidth || 0,
            height: video.PixelHeight || 0,
            channels: audio.Channels || 2,
            bitDepth: audio.BitDepth || 0,
            sampleRate: rate,
            // Bytes header-stripping removed from every frame, to prepend back.
            stripped: encoding
        };

        // Per-frame duration, in timescale ticks. Needed for the final sample of
        // a cluster, and to space out lacing-packed audio frames.
        track.defaultDuration = entry.DefaultDuration
            ? Math.round(entry.DefaultDuration / scale)
            : Math.round((map.oti === 0x40 ? 1024 : 1152) / rate * timescale);

        var codec = mkv.codecString(track);
        var mime = (type === 1 ? 'video/mp4' : 'audio/mp4') + '; codecs="' + codec + '"';

        if (!MediaSource.isTypeSupported(mime)) {
            if (DEBUG_INFO) {
                console.debug('Unsupported %s track.', type === 1 ? 'video' : 'audio', mime);
            }
            if (type === 2) {
                // Video keeps playing; the player surfaces l[19060].
                self._hasUnsupportedAudio = codec;
            }
            continue;
        }

        track.mime = mime;
        track.init = mkv.buildInitSegment(track);

        if (type === 1) {
            self._hasVideo = codec;
        }
        else {
            self._hasAudio = codec;
        }

        if (DEBUG_INFO) {
            console.debug('Track%s: %s -> %s', entry.TrackNumber, codecId, mime);
        }

        self._trackMap[track.number] = track;
        self._tracks.push(track);
        data.push({mime: mime, init: track.init});
    }

    if (!data.length) {
        return false;
    }

    self._fmp4 = true;
    return data;
};

/**
 * Inspect a track's ContentEncodings.
 *
 * Matroska lets a track declare that its frames were transformed on the way in.
 * The only variant we can undo is "header stripping" (ContentCompAlgo 3), where
 * a run of bytes identical across every frame is removed and stored once in
 * ContentCompSettings; those bytes simply get prepended back. Anything else --
 * zlib/bzlib/lzo compression, or encryption -- we cannot reverse.
 *
 * @param {Object} entry TrackEntry
 * @returns {Buffer|null|false} bytes to prepend, null if untouched, false if
 *                              the encoding is one we cannot undo
 */
function readContentEncoding(entry) {
    var encodings = entry.ContentEncodings;

    if (!encodings) {
        return null;
    }

    var encoding = encodings.ContentEncoding;
    if (Array.isArray(encoding)) {
        // Several encodings would have to be unwound in order; we only ever
        // handle the single header-stripping case.
        if (encoding.length > 1) {
            return false;
        }
        encoding = encoding[0];
    }
    if (!encoding) {
        return null;
    }

    if (encoding.ContentEncryption) {
        return false;
    }

    var compression = encoding.ContentCompression;
    if (!compression) {
        return null;
    }

    // ContentCompAlgo defaults to 0 (zlib) when absent, so an empty
    // ContentCompression element still means "compressed".
    if ((compression.ContentCompAlgo | 0) !== 3) {
        return false;
    }

    var settings = compression.ContentCompSettings;

    // Algo 3 with no settings strips nothing, which is a no-op rather than a
    // failure.
    return settings && settings.length ? settings : null;
}

/**
 * Collect the Cues into the seek table used by _findCluster().
 * @param {Object} segment parsed init segment
 */
EBMLRemuxer.prototype._buildSeekTable = function(segment) {
    if (!segment.Cues) {
        return;
    }
    this._shrink(segment, {Cues: 'CuePoint'});

    var c = segment.Cues;
    var y = segment.playtime;
    var t = this._seekTable = [];

    for (var j = c.length; j--;) {
        var p = c[j];
        var x = p.CueTrackPositions;
        var z = Math.round((p.CueTime * segment.timescale) * 1000) / 1000;

        t.push([z, y, x.CueClusterPosition + segment.offset]);
        y = z;
    }
};

/**
 * Historic path: hand raw EBML straight to a video/webm SourceBuffer.
 * @param {Array} tracks TrackEntry list
 * @param {Object} segment parsed init segment
 * @returns {Array|false} per-track {mime, init}, or false when not applicable
 */
EBMLRemuxer.prototype._setupPassthrough = function(tracks, segment) {
    var getCodec = function(codec) {
        var c = String(codec).substr(2).toLowerCase();
        if (c === 'av1') {
            c = 'av01.0.00M.08';
        }
        return c;
    };
    var getMime = function(codec, type) {
        switch (codec) {
            case 'A_VORBIS':
            case 'A_OPUS':
            case 'V_VP8':
            case 'V_VP9':
            case 'V_AV1':
                return (type === 1 ? 'video' : 'audio') + '/webm; codecs="' + getCodec(codec) + '"';
        }
    };

    for (var i = tracks.length; i--;) {
        var track = tracks[i];
        var codec = String(track.CodecID).replace(/\W/g, '');
        var type = track.TrackType;
        var mime = getMime(codec, type);

        if (DEBUG_INFO) {
            console.debug('Track%s, %s, %s', track.TrackNumber, codec, mime, track);
        }

        if (!mime) {
            continue;
        }

        if (!this._hasVideo && type === 1) {
            this._hasVideo = codec;
        }
        else if (!this._hasAudio && type === 2) {
            if (MediaSource.isTypeSupported(mime)) {
                this._hasAudio = codec;
            }
            else {
                if (DEBUG_INFO) {
                    console.debug('Unsupported audio track.', mime);
                }
                continue;
            }
        }
        else {
            continue;
        }

        track.mime = mime;
    }

    if (this._hasVideo) {
        var mime = 'video/webm; codecs="' + getCodec(this._hasVideo);

        if (this._hasAudio) {
            mime += ',' + getCodec(this._hasAudio);
        }

        this._tracks.push({mime: mime + '"'});
    }
    else if (this._hasAudio) {
        this._tracks.push({mime: 'audio/webm; codecs="' + getCodec(this._hasAudio) + '"'});
    }

    if (!this._tracks.length) {
        return false;
    }

    return this._tracks.map(function(track) {
        return {
            mime: track.mime,
            init: segment.data
        };
    });
};

EBMLRemuxer.prototype._shrink = function(segment, props) {
    for (var k in props) {
        if (segment[k] && (segment[k] = segment[k][props[k]])) {
            if (!Array.isArray(segment[k])) {
                segment[k] = [segment[k]];
            }
        }
    }
};

EBMLRemuxer.prototype._createReader = function(offset, target, event, cb) {
    var self = this;
    // The offset-0 scan that finds the init segment runs before _trackMap
    // exists, so it never pays for frame extraction.
    var reader = new EBMLReader(self._file, offset, self._trackMap);

    if (typeof target === 'string') {
        cb = event;
        event = target;
        target = self;
    }

    reader.on(event, function() {
        cb.apply(reader, arguments);
    });

    reader.on('error', function(err) {
        target.destroy(err);
    });

    return reader;
};

EBMLRemuxer.prototype.setInitSegment = function(segment) {
    var self = this;
    var info = segment.Info;

    // Raw TimecodeScale in nanoseconds (Matroska's default is 1ms). The fMP4
    // path needs it unscaled to derive an integer mdhd timescale, whereas the
    // passthrough path wants the seconds-per-tick form below.
    segment.timecodeScale = info && info.TimecodeScale || 1e6;

    if (info) {
        segment.timescale = info.TimecodeScale / 1e9;
        segment.playtime = info.Duration * segment.timescale;
    }
    this._shrink(segment, {'Tracks': 'TrackEntry', 'SeekHead': 'Seek', 'Tags': 'Tag'});

    if (!segment.Cues && segment.SeekHead) {
        var cuesOffset = -1;

        for (var i = segment.SeekHead.length; i--;) {
            var seekHead = segment.SeekHead[i];

            if (seekHead.SeekID.readInt32BE() === 0x1c53bb6b) {
                cuesOffset = seekHead.SeekPosition + segment.offset;
                break;
            }
        }

        if (cuesOffset > 0) {
            this._createReader(cuesOffset, 'cues', function(chunk) {
                segment.Cues = chunk.Cues;
                self.emitInitSegment(segment);
                this.destroy();
            });
            return;
        }
    }

    this.emitInitSegment(segment);
};

EBMLRemuxer.prototype._findCluster = function(time) {
    var offset = 0;
    var t = this._seekTable;

    // The player asks in media time, which once holes have been closed runs
    // ahead of the file time the cue table is indexed by. Convert in, and report
    // the fixup back out in media time -- returning a file time there makes
    // _tryPump() see a permanent discrepancy and coerce backwards on every seek.
    time = this._fileTimeFor(time);

    this._seekTime = time = Math.round(time * 1000) / 1000;

    for (var i = 0; i < t.length; ++i) {
        var x = t[i][0];
        var y = t[i][1];
        var z = t[i][2];

        if (time >= x && time <= y) {
            time = x;
            offset = t[i + 1] ? t[i + 1][2] : z;
            break;
        }
    }

    // Cue times are file times, but once holes have been closed the media plays
    // earlier than the file says. Report the shifted time so the player seeks to
    // where the data actually landed.
    this._seekTimeFixup = time - this._skippedBefore(time * this._timescale) / this._timescale;

    return offset || this._initSegment.data.length;
};

EBMLRemuxer.prototype.seek = function(time) {
    var self = this;
    var offset = self._findCluster(time);

    // console.warn('ebml:seek', time, offset, [this]);

    if (self._fmp4) {
        return self._seekFmp4(offset);
    }

    return self._tracks.map(function(track, i) {
        if (track.outStream) {
            track.outStream.destroy();
        }
        return track.outStream = new MediaSegment(self, offset);
    });
};

/**
 * fMP4 counterpart of seek().
 *
 * Unlike the passthrough path -- where each track owns its own reader -- video
 * and audio are interleaved in the same Matroska clusters, so a single reader
 * is demultiplexed into one stream per track. Giving each track its own reader
 * would download the file twice.
 *
 * @param {Number} offset byte offset of the cluster to start from
 * @returns {Array} one stream per track, parallel to the 'ready' track list
 */
EBMLRemuxer.prototype._seekFmp4 = function(offset) {
    var self = this;

    if (self._clusterReader) {
        self._clusterReader.destroy();
        self._clusterReader = null;
    }

    var streams = self._tracks.map(function(track) {
        if (track.outStream) {
            track.outStream.destroy();
        }
        return track.outStream = new Fmp4Segment(self, track);
    });

    self._openClusterReader(offset, streams);

    return streams;
};

/**
 * Attach a cluster reader feeding the given per-track output streams.
 * @param {Number} offset byte offset of the cluster to read from
 * @param {Array} streams per-track Fmp4Segment streams
 */
EBMLRemuxer.prototype._openClusterReader = function(offset, streams) {
    var self = this;
    var endOfStream = function() {
        for (var i = streams.length; i--;) {
            if (!streams[i].destroyed) {
                // Let out whatever the reorder window is still holding.
                streams[i].flush();
                streams[i].push(null);
                streams[i].destroy();
            }
        }
        self._clusterReader = null;
    };

    var reader = self._createReader(offset, 'cluster', function(cluster, timecode, duration, frames) {
        if (cluster === null) {
            if (DEBUG_INFO) {
                console.debug('fmp4 EOS');
            }
            endOfStream();
            this.destroy();
            return;
        }

        if (self._resyncGap) {
            self._measureGap(streams, frames);
        }

        for (var i = 0; i < self._tracks.length; i++) {
            streams[i].appendFrames(frames[self._tracks[i].trackId]);
        }
    });

    // A malformed or junk-padded element makes the EBML decoder throw, which
    // would otherwise destroy the reader and end playback early -- exactly what
    // happens on files carrying inter-cluster padding. Rather than give up,
    // jump to the next cue point and carry on from there.
    reader.removeAllListeners('error');
    reader.on('error', function(err) {
        // A detected desync knows the exact cluster boundary to restart from;
        // otherwise fall back to wherever the decoder had got to. Both are
        // absolute file offsets.
        var start = this._byteOffset;
        var from = this._resyncFrom || start + Object(this._decoder)._total;
        var next = self._nextClusterAfter(Math.max(from, start + 1) - 1);

        this.destroy();

        // Only ever move forward: resyncing to a cluster at or behind where this
        // reader began would re-read the very bytes that just broke it.
        if (next > start && self._clusterReader === this) {
            if (DEBUG_INFO) {
                console.warn('Recovering from "%s" at %s; resuming at %s.', err && err.message, from, next);
            }
            // Frames still held for reordering belong before the discontinuity,
            // so let them out now rather than ordering them against what comes
            // after the gap.
            for (var s = 0; s < streams.length; s++) {
                streams[s].flush();
            }

            // Whatever sat between here and there is gone; measure the hole off
            // the first cluster that arrives so playback can run straight over it.
            self._resyncGap = true;
            self._openClusterReader(next, streams);
            return;
        }

        if (DEBUG_INFO) {
            console.warn('Unrecoverable read error at %s.', from, err);
        }
        endOfStream();
    });

    self._clusterReader = reader;
};

/**
 * Work out how much media a resync skipped, and fold it into _timeShift.
 *
 * Called once for the first cluster after a resync. A single shift is derived
 * from one reference track and applied to every track, so audio and video stay
 * locked to each other rather than drifting apart by their individual rounding.
 *
 * @param {Array} streams per-track output streams
 * @param {Object} frames trackId -> frame list for the new cluster
 */
EBMLRemuxer.prototype._measureGap = function(streams, frames) {
    this._resyncGap = false;

    for (var i = 0; i < this._tracks.length; i++) {
        var list = frames[this._tracks[i].trackId];
        var previousEnd = streams[i].lastRawEnd;

        if (!list || !list.length || previousEnd === null) {
            continue;
        }

        // Frames are in storage order, so the earliest presentation time is not
        // necessarily the first one.
        var first = list[0].pts;
        for (var j = 1; j < list.length; j++) {
            if (list[j].pts < first) {
                first = list[j].pts;
            }
        }

        if (first > previousEnd) {
            this._recordSkip(previousEnd, first);
        }
        return;
    }
};

/**
 * Remember a hole in the file timeline, merging it with any already known.
 * Re-reading the same damaged region must not widen the total.
 * @param {Number} from start of the hole, in timescale ticks
 * @param {Number} to end of the hole, in timescale ticks
 */
EBMLRemuxer.prototype._recordSkip = function(from, to) {
    var merged = [{from: from, to: to}];

    for (var i = 0; i < this._skipped.length; i++) {
        var range = this._skipped[i];
        var head = merged[merged.length - 1];

        if (range.from > head.to || range.to < head.from) {
            merged.push(range);
        }
        else {
            head.from = Math.min(head.from, range.from);
            head.to = Math.max(head.to, range.to);
        }
    }

    merged.sort(function(a, b) {
        return a.from - b.from;
    });
    this._skipped = merged;

    if (DEBUG_INFO) {
        console.warn('Closing a %sms hole at %s; total skipped now %sms.',
            to - from, from, this._skippedBefore(Infinity));
    }
};

/**
 * Media time -> file time, the inverse of the hole-closing shift.
 * @param {Number} mediaTime seconds as the player sees them
 * @returns {Number} seconds as the file numbers them
 */
EBMLRemuxer.prototype._fileTimeFor = function(mediaTime) {
    var ticks = mediaTime * this._timescale;
    var shift = 0;

    for (var i = 0; i < this._skipped.length; i++) {
        // Compare against the hole's start already pulled back by the holes
        // before it -- that is where it sits on the media timeline.
        if (this._skipped[i].from - shift > ticks) {
            break;
        }
        shift += this._skipped[i].to - this._skipped[i].from;
    }

    return (ticks + shift) / this._timescale;
};

/**
 * Total media skipped before a point on the file timeline.
 * @param {Number} pts presentation time, in timescale ticks
 * @returns {Number} ticks to subtract so the timeline stays contiguous
 */
EBMLRemuxer.prototype._skippedBefore = function(pts) {
    var total = 0;

    for (var i = 0; i < this._skipped.length; i++) {
        // Keyed on where the hole starts, not where it ends: tracks resume at
        // slightly different times, so an audio frame can legitimately land
        // inside a range measured from the video track and still be past it.
        if (this._skipped[i].from > pts) {
            break;
        }
        total += this._skipped[i].to - this._skipped[i].from;
    }

    return total;
};

/**
 * Next cue'd cluster position strictly after a byte offset.
 * @param {Number} offset byte offset to search from
 * @returns {Number} offset of the next cluster, or -1 when there is none
 */
EBMLRemuxer.prototype._nextClusterAfter = function(offset) {
    var t = this._seekTable;
    var best = -1;

    // The seek table is built back-to-front, so it is not in ascending order.
    for (var i = 0; t && i < t.length; ++i) {
        var pos = t[i][2];

        if (pos > offset && (best < 0 || pos < best)) {
            best = pos;
        }
    }

    return best;
};

// @private
function EBMLReader(file, offset, trackMap) {
    this.$etup();

    this._file = file;
    this._conGroup = 0;
    this._cluster = null;
    this._ebmlOffset = 0;
    this._lastBlock = null;
    this._clusterCount = 0;
    this._segmentOffset = 0;
    this._timecodes = [0, 0];
    this._clusterOffset = -1;
    this._byteOffset = offset;
    this._trackDefaultDuration = 0;
    this._segment = Object.create(null);

    // fMP4 mode only: split each cluster's blocks into per-track frame lists.
    this._trackMap = trackMap || null;
    this._frames = Object.create(null);
    this._currentTimecode = 0;
    this._groupFrames = null;
    this._groupHasRef = false;
    this._clusterEnd = 0;
    this._resyncFrom = 0;

    try {
        // The ring buffer only exists so whole elements can be sliced back out
        // by absolute offset. The fMP4 path never does that -- it works from the
        // decoder's own frame data -- so it needs room for one incoming chunk,
        // not 32MB. Allocating 32MB per reader, on every seek and every resync,
        // was enough churn to visibly stall the browser.
        this.$buffer = new Buffer(this._trackMap ? 0x100000 : 0x2000000);
    }
    catch (ex) {
        vsNT(this.emit.bind(this, 'error', ex));
        return this;
    }
    this.$head = 0;

    this._decoder = new EBMLDecoder();
    this._fileStream = file.createReadStream({start: offset});
    this._fileStream.pipe(this);

    var self = this;
    this._decoder.on('data', function(chunk) {
        self._onData(chunk[0], chunk[1]);
    });

    this.on('finish', function() {
        self._onFinish();
    });
}

createStream(EBMLReader, stream.Writable, function() {
    if (this._fileStream) {
        this._fileStream.destroy();
        this._fileStream = null;
    }
    if (this._decoder) {
        this._decoder.end();
        this._decoder.destroy();
        this._decoder = null;
    }
    this.$buffer = null;
    this._cluster = null;

    while (this._conGroup-- > 0) {
        console.groupEnd();
    }
});

EBMLReader.prototype._getValue = function(chunk) {
    // https://www.matroska.org/technical/specs/index.html
    var data = chunk.data;
    if (chunk.type === 'b') {
        return data;
    }
    if (chunk.type === 's') {
        return data.toString('ascii');
    }
    if (chunk.type === '8') {
        return data.toString('utf-8');
    }
    if (chunk.type === 'f') {
        return chunk.dataSize < 8 ? data.readFloatBE() : data.readDoubleBE();
    }

    var value = 0;
    for (var i = 0; i < chunk.dataSize; i++) {
        value |= data[i] << 8 * (chunk.dataSize - i - 1);
    }
    return value;
};

EBMLReader.prototype._emitCluster = function(duration) {
    var h = ~this._clusterCount & 1;
    var timecode = this._timecodes[h];
    var frames = this._frames;

    // The frames gathered so far belong to the cluster being emitted; the next
    // one starts collecting into a fresh set.
    this._frames = Object.create(null);

    this.emit('cluster', this._cluster, timecode, duration, frames);
    this._cluster = null;
};

/**
 * Split a Block/SimpleBlock into frames and file them under their track.
 * @param {Object} data decoded EBML tag
 * @param {Boolean} simple true for SimpleBlock
 */
EBMLReader.prototype._collectBlock = function(data, simple) {
    var parsed = mkv.parseBlock(data.data, simple);

    if (!parsed) {
        return;
    }

    var track = this._trackMap[parsed.trackNumber];
    if (!track) {
        return;
    }

    var list = this._frames[track.trackId] || (this._frames[track.trackId] = []);
    var from = list.length;
    var pts = this._currentTimecode + parsed.timecode;

    for (var i = 0; i < parsed.frames.length; i++) {
        var frame = parsed.frames[i];

        if (track.stripped) {
            // Matroska header stripping: bytes common to every frame are stored
            // once on the track and removed from the frames themselves. Put them
            // back, or an H.264 length prefix is short by exactly that much.
            frame = Buffer.concat([track.stripped, frame]);
        }

        list.push({
            // Lacing packs several frames under one timecode; space them out by
            // the track's frame duration or they all collapse onto one PTS.
            pts: pts + i * track.defaultDuration,
            keyframe: parsed.keyframe,
            data: frame
        });
    }

    if (!simple) {
        // A plain Block carries no keyframe bit -- the enclosing BlockGroup
        // decides, via the presence of a ReferenceBlock.
        this._groupFrames = {list: list, from: from};
    }
};

EBMLReader.prototype._onFinish = function() {
    var v = -1;
    var s = this._clusterOffset;
    if (s > 0) {
        var b = this._lastBlock;
        var d = b.data;
        var dur = (d.readUInt32BE(0) / 1e6) | 0;
        var t = this._timecodes[this._clusterCount & 1] + dur;

        this._addTimeCode(t);

        v = -dur;
        // Same as above: the fMP4 path has no use for the raw bytes, and its
        // ring buffer is far too small to slice a whole cluster out of.
        this._cluster = this._trackMap ? true : this._read(s, b.end);
    }
    if (this._cluster !== null) {
        this._emitCluster(v);
    }
    this.emit('cluster', null);
    this.destroy();
};

lazy(EBMLReader.prototype, '_clearDefaultDuration', function() {
    // XXX: Apparently, recent Chrome versions (85+) does not need the default duration cleaned, tho
    return !localStorage.vsncdd && window.chrome !== undefined || localStorage.vscdd;
});

EBMLReader.prototype._onData = function(state, data) {
    var tmp;

    if (DEBUG_VERBOSE && data.name !== 'SimpleBlock') {
        if (state === 'start') {
            this._conGroup++;
            console.group(data.name);
        }

        console.log('state=%s, data=%s', state, data.name, state === 'tag' && [this._getValue(data)], data);

        if (state === 'end') {
            this._conGroup--;
            console.groupEnd();
        }
    }

    if (state === 'start') {
        if (!this._byteOffset) {
            // Retrieving initialization segment.

            if (data.name === 'EBML') {
                this._ebmlOffset = data.start;
            }
            else if (data.name === 'Segment') {
                this._segmentOffset = -1;
            }
            else if (this._segmentOffset < 0) {
                this._segmentOffset = data.start;
            }
            else if (data.name === 'Cluster') {
                var segment = this._segment;
                this._segment = false;

                delete segment.$;
                segment.offset = this._segmentOffset;
                segment.data = this._read(this._ebmlOffset, data.start);

                /**/
                var dd = this._trackDefaultDuration;
                if (dd && this._clearDefaultDuration) {
                    if (DEBUG_INFO) {
                        console.debug('Cleaning DefaultDuration...\n' + hexdump(segment.data, dd.start).slice(0, 4).join('\n'));
                    }

                    var size = dd.dataSize;
                    if (size > 4) {
                        console.warn('Unexpected default duration...', dd);
                    }
                    else {
                        segment.data.writeUInt32BE(0x25868880 + size, dd.start);

                        while (size-- > 0) {
                            segment.data.writeUInt8(0x20, 4 + dd.start + size);
                        }
                    }
                }
                /**/

                var x = segment;
                if (x.Segment) {
                    console.warn('left over segment', x.Segment);
                    Object.assign(x, x.Segment);
                    delete x.Segment;
                }

                this.emit('segment', segment);
                return;
            }
        }

        if (data.name === 'Cues' && this._cluster !== null) {
            return this._onFinish();
        }

        if (data.name === 'BlockGroup') {
            this._groupFrames = null;
            this._groupHasRef = false;
        }

        if (data.name === 'Cluster') {
            this._clusterEnd = data.end;
        }

        tmp = Object.create(null);
        tmp.$ = this._segment;

        if (this._segment[data.name]) {
            if (Array.isArray(this._segment[data.name])) {
                this._segment[data.name].push(tmp);
            }
            else {
                this._segment[data.name] = [this._segment[data.name], tmp];
            }
        }
        else {
            this._segment[data.name] = tmp;
        }
        this._segment = tmp;
    }
    else if (state === 'end') {
        var name = data.name.toLowerCase();
        var C = name === 'cluster';
        var E = C && data.end === -1;

        if (name === 'blockgroup' && this._groupFrames) {
            var group = this._groupFrames;

            for (var g = group.from; g < group.list.length; g++) {
                group.list[g].keyframe = !this._groupHasRef;
            }
            this._groupFrames = null;
        }

        tmp = this._segment;
        this._segment = tmp.$;
        delete tmp.$;

        if (data.end - data.start > 0 || E) {

            if (this.listenerCount(name)) {
                // Skip the copy for fMP4 clusters -- those bytes are never read,
                // and at a megabyte-plus per cluster the churn is not free.
                var chunk = !E && !(C && this._trackMap) && this._read(data.start, data.end);

                if (C) {
                    if (E) {
                        var s = this._clusterOffset;
                        if (s >= 0) {
                            // fMP4 only needs to know a cluster closed; the raw
                            // bytes are the passthrough path's business.
                            this._cluster = this._trackMap ? true : this._read(s, data.start);
                        }
                        this._clusterOffset = data.start;
                    }
                    else {
                        // `chunk` is false on the fMP4 path; anything non-null
                        // works as the "a cluster closed" sentinel.
                        this._cluster = chunk || true;
                    }
                }
                else {
                    if (name === 'cues') {
                        tmp = this._segment;
                        tmp.data = chunk;
                        chunk = tmp;
                    }
                    this.emit(name, chunk);
                }
            }
        }
        else {
            console.warn('Empty master element...', data);
        }
    }
    else {
        // Junk bytes inside a Cluster can collide with a real element id -- a
        // stray 0xEA reads as CueCodecState -- and whatever vint follows is
        // taken as its size, swallowing the rest of the file. No element may
        // extend past its Cluster's declared end, so that overrun is a reliable
        // desync signal; bail out and let the cue table put us back on track.
        if (this._clusterEnd > 0 && data.end > this._clusterEnd) {
            // Decoder offsets restart at 0 for every reader, whereas the cue
            // table holds absolute file positions -- so this has to be rebased,
            // or the resync lands behind us and loops on the same junk.
            this._resyncFrom = this._byteOffset + this._clusterEnd;

            return this.destroy(new Error(
                'Desync: ' + data.name + ' (' + data.dataSize + ' bytes) overruns its cluster.'
            ));
        }

        if (data.name === 'SimpleBlock' || data.name === 'Block') {
            this._lastBlock = data;

            if (this._trackMap) {
                this._collectBlock(data, data.name === 'SimpleBlock');
            }
        }
        else {
            this._segment[data.name] = this._getValue(data);

            if (data.name === 'ReferenceBlock') {
                this._groupHasRef = true;
            }
        }

        if (data.name === 'Timecode') {
            this._addTimeCode(this._getValue(data));
        }
        else if (data.name === 'DefaultDuration') {
            this._trackDefaultDuration = data;
        }
    }
};

EBMLReader.prototype._addTimeCode = function(v) {
    var h = ++this._clusterCount & 1;

    this._timecodes[h] = v;

    // Blocks carry a timecode relative to their cluster, so frames collected
    // from here on are offset against this value.
    this._currentTimecode = v;

    if (this._cluster !== null) {
        this._emitCluster(this._timecodes[h] - this._timecodes[~h & 1]);
    }
};

EBMLReader.prototype._read = function(start, end) {
    var length = end - start;
    var buffer = new Buffer(length);
    var offset = start % this.$buffer.length;
    var left = this.$buffer.length - offset;

    // console.warn('ebml:read', arguments);

    if (length > this.$buffer.length) {
        this.destroy(new Error('ebml:read buffer overflow.'));
    }
    else if (length > left) {
        this.$buffer.copy(buffer, 0, offset, this.$buffer.length);
        this.$buffer.copy(buffer, left, 0, length - left);
    }
    else {
        this.$buffer.copy(buffer, 0, offset, offset + length);
    }

    return buffer;
};

EBMLReader.prototype._write = function(chunk, enc, cb) {
    if (chunk.length > this.$buffer.length) {
        return this.destroy(new Error('ebml:write buffer overflow.'));
    }

    // console.warn('ebml:write', arguments);

    var left = this.$buffer.length - this.$head;
    if (chunk.length > left) {
        chunk.copy(this.$buffer, this.$head, 0, left);
        chunk.copy(this.$buffer, 0, left, chunk.length);
        this.$head = (chunk.length - left);
    }
    else {
        chunk.copy(this.$buffer, this.$head);
        this.$head += chunk.length;
    }

    try {
        this._decoder.write(chunk);
        cb();
    }
    catch (ex) {
        this.destroy(ex);
    }
};

/**
 * @private
 * Output stream for one fMP4 track. The remuxer drives it by handing over the
 * frames it demultiplexed out of each cluster.
 * @param {EBMLRemuxer} muxer owning remuxer
 * @param {Object} track internal track descriptor
 */
function Fmp4Segment(muxer, track) {
    this.$etup();

    var s = muxer._initSegment;
    this.muxer = muxer;
    this.track = track;
    this.segment = s;
    this.playtime = s.playtime;
    this.timescale = s.timescale;

    // End of the last batch, before any gap-closing shift, so a later resync can
    // measure the hole against the file's own timeline.
    this.lastRawEnd = null;

    // Decode times are fixed across cluster boundaries rather than within them;
    // see Reorderer. Audio never reorders, so it needs no window.
    this.reorder = new mkv.Reorderer(track.type === 1 ? REORDER_DEPTH : 0, track.defaultDuration);

    // Timestamped frames waiting to make up a whole fragment. Emitting one per
    // cluster is no good when clusters are short: fragments then span less than
    // a reordering group, so consecutive ones overlap in presentation time and
    // the browser tears its buffered range at every boundary.
    this.buffer = [];
}

createStream(Fmp4Segment, stream.PassThrough, function() {
    this.end();
});

/**
 * Turn one cluster's worth of frames into a media segment.
 * @param {Array} [frames] frames belonging to this track
 */
Fmp4Segment.prototype.appendFrames = function(frames) {
    if (this.destroyed) {
        return;
    }

    // Decode times are fixed by a window spanning cluster boundaries, so what
    // comes back is not this cluster's frames but whichever earlier ones the
    // window has now released.
    this.emitFrames(this.reorder.push(frames || []));
};

/**
 * Release everything still held for reordering -- at end of stream, or before a
 * resync discontinuity makes the held frames meaningless.
 */
Fmp4Segment.prototype.flush = function() {
    if (!this.destroyed) {
        this.emitFrames(this.reorder.flush());
        this.drainFragments(true);
    }
};

/**
 * Emit fully timestamped frames as one or more fMP4 fragments.
 * @param {Array} frames frames with dts, cts and duration set
 */
Fmp4Segment.prototype.emitFrames = function(frames) {
    if (this.destroyed || !frames || !frames.length) {
        return;
    }

    var track = this.track;
    var tail = frames[frames.length - 1];
    this.lastRawEnd = tail.dts + tail.duration;

    // Pull everything after a skipped cluster back over the hole. Only `dts`
    // needs moving: `cts` is a delta from it, so composition order is unaffected.
    // Derived from position rather than a running total, so re-reading a damaged
    // region after a seek yields the same shift instead of compounding.
    var shift = this.muxer._skippedBefore(frames[0].pts);
    if (shift > 0) {
        for (var s = 0; s < frames.length; s++) {
            frames[s].dts -= shift;
        }
    }

    if (DEBUG_VERBOSE) {
        console.debug('%s: %s samples, dts %s..%s', this, frames.length,
            frames[0].dts, frames[frames.length - 1].dts);
    }

    this.buffer = this.buffer.length ? this.buffer.concat(frames) : frames;
    this.drainFragments(false);
};

/**
 * Cut whole fragments off the front of the buffer.
 * @param {Boolean} all also emit the remainder, however short
 */
Fmp4Segment.prototype.drainFragments = function(all) {
    var track = this.track;
    var buffer = this.buffer;
    var limit = MIN_FRAGMENT_DURATION * track.timescale;
    var from = 0;

    for (var i = 1; i < buffer.length; i++) {
        // Break only at a sync sample, exactly as mp4-remuxer.js does: starting
        // a fragment mid-GOP puts a B-frame first, whose negative composition
        // offset precedes the previous fragment's end. Audio has no such
        // constraint, and not every audio block flags itself as a sync sample.
        if (track.type === 1 && !buffer[i].keyframe) {
            continue;
        }

        if (buffer[i].dts - buffer[from].dts >= limit) {
            // NB: deliberately no `duration` property on the pushed buffer --
            // that is the passthrough path's signal for videostream.js to start
            // juggling sb.timestampOffset, which fMP4 must not do since tfdt is
            // absolute.
            this.push(mkv.buildMediaSegment(track, buffer.slice(from, i)));
            from = i;
        }
    }

    this.buffer = buffer.slice(from);

    if (all && this.buffer.length) {
        this.push(mkv.buildMediaSegment(track, this.buffer));
        this.buffer = [];
    }
};

// @private
function MediaSegment(muxer, offset) {
    var self = this;
    this.$etup();

    var s = muxer._initSegment;
    this.segment = s;
    this.playtime = s.playtime;
    this.timescale = s.timescale;
    this.seektime = muxer._seekTime;
    this._reader = null;

    this._async(function() {
        self._reader = muxer._createReader(offset, self, 'cluster', function(cluster) {
            if (!self.destroyed) {
                if (cluster) {
                    self.append.apply(self, arguments);
                }
                else {
                    if (DEBUG_INFO) {
                        console.debug(self + ' EOS', cluster === null);
                    }
                    self.push(null);
                    self.destroy();
                }
            }
        });
    });
}

createStream(MediaSegment, stream.PassThrough, function(err) {
    if (this._reader) {
        this._reader.destroy(err);
        this._reader = null;
    }
    this.end();
});

MediaSegment.prototype.hexdump = function(data) {
    var h = hexdump(data);
    console.log(h.slice(0, 12).join('\n') + '\n........\n' + h.slice(h.length - 4).join('\n'));
};

MediaSegment.prototype.append = function(cluster, timecode, duration) {
    // this.hexdump(cluster);

    if (duration < 0) {
        if (!this.playtime) {
            this.playtime = (timecode + -duration) * this.timescale;
        }
        duration = this.playtime / this.timescale - timecode;

        if (DEBUG_INFO) {
            console.debug(this + ' Last cluster, duration:', duration);
        }
    }

    var timecodeOffset = -1;
    var cs = cluster.readUInt32BE(4);

    if (cs === 0x1000000) {
        timecodeOffset = 12;
    }
    else {
        if (cs === 0x1FFFFFF || !this.segment.playtime) {
           if (DEBUG_INFO) {
                console.warn('non-seekable cluster, 0x%s', cluster.toString('hex', 0, 32));
            }
            this.push(this.segment.data);
        }
        timecodeOffset = (12 - Math.floor(Math.log2(cs >>> 24))) | 0;
    }

    if (timecodeOffset > 0) {
        cs = cluster.readUInt16BE(timecodeOffset);
        if ((cs >> 8) === 0xBF) {
            if (DEBUG_INFO) {
                console.debug(this + ' mkv timecode fixup (0x%s)', cluster.toString('hex', 0, timecodeOffset+9));
            }
            // skip crc-32 value
            cs = cluster.readUInt16BE(timecodeOffset += 6);
        }
        if ((cs >> 8) === 0xE7 && (cs & 0xff) > 0x7F) {
            cluster.timecode = timecode * this.timescale;
            cluster.duration = duration * this.timescale;

            if (this.seektime !== -1) {
                cluster.seektime = this.seektime;
                this.seektime = -1;
            }

            var len = cs & ~0xFF80;
            var offset = timecodeOffset + 2;

            while (len-- > 0) {
                cluster.writeUInt8(0, offset++);
            }
        }
        else if (DEBUG_INFO) {
            console.warn('Unexpected timecode offset...');
        }
    }
    else if (DEBUG_INFO) {
        console.warn('Unexpected cluster data size...');
        this.hexdump(cluster);
    }

    this.push(cluster);
};

// @private
function createStream(dest, source, destroy) {
    inherits(dest, source);

    dest.prototype.$etup = function() {
        var self = this;

        self.$iid = (Math.random() * Date.now() | 0).toString(16).slice(-6);
        self.destroyed = false;
        source.call(self);

        if (DEBUG_VERBOSE) {
            var _emit = this.emit;
            this.emit = function(event) {
                if (event !== 'data' || DEBUG_ALL) {
                    console.warn(this + '.emit(%s)', event, arguments, [this]);
                }
                return _emit.apply(this, arguments);
            };
        }
    };

    dest.prototype._async = function(cb) {
        var self = this;
        queueMicrotask(function() {
            if (!self.destroyed) {
                cb.call(self);
            }
        });
    };

    destroy = destroy && tryCatch(destroy);
    dest.prototype.destroy = function(err) {
        if (DEBUG_INFO) {
            var fn = err ? 'error' : 'debug';
            console[fn](this + '.destroy', this.destroyed, [this], err);
        }

        if (!this.destroyed) {
            this.destroyed = true;

            if (destroy) {
                destroy.call(this, err);
            }

            if (err) {
                this.emit('error', err);
            }
            this.emit('close');
        }
    };

    dest.prototype.toString = function() {
        return this.constructor.name + '[$' + this.$iid + ']';
    };
}

// @private
function hexdump(buffer, offset, length) {
    offset = offset || 0;
    length = length || buffer.length;

    var out = [];
    var row = "";
    for (var i = 0; i < length; i += 16) {
        row = ('0000000' + offset.toString(16).toUpperCase()).slice(-8) + ":  ";
        var n = Math.min(16, length - offset);
        var string = "";
        for (var j = 0; j < 16; ++j) {
            if (j && !(j % 4)) {
                row += " ";
            }
            if (j < n) {
                var value = buffer.readUInt8(offset);
                string += value > 0x1f && value < 0x7f ? String.fromCharCode(value) : ".";
                row += ("0" + value.toString(16).toUpperCase()).slice(-2);
                offset++;
            }
            else {
                row += "  ";
                string += " ";
            }
        }
        out.push(row + "  " + string);
    }
    return out;
}
