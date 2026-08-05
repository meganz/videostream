'use strict';

// Matroska -> fragmented-MP4: builds ftyp+moov init segments and moof+mdat
// media segments, reusing the mp4-box-encoding boxes mp4-remuxer.js registers.

var Box = require('mp4-box-encoding');
var Buffer = require('buffer').Buffer;
var tools = require('ebml/lib/ebml/tools');

// CodecPrivate is the decoder configuration record and the frames are already
// AVCC length-prefixed, so both are straight byte copies.
var VIDEO_CODECS = {
    'V_MPEG4/ISO/AVC': {entry: 'avc1', config: 'avcC'},
    // Not a typo: some muxers wrote 'IS0' with a digit zero, and MediaInfo
    // carries entries for both spellings.
    'V_MPEG4/IS0/AVC': {entry: 'avc1', config: 'avcC'},
    'V_MPEGH/ISO/HEVC': {entry: 'hvc1', config: 'hvcC'}
};

// Anything absent is reported as unsupported audio, so the track is dropped and
// the video plays silently -- DTS, AC-3, E-AC-3 and TrueHD all land there.
var AUDIO_CODECS = {
    'A_AAC': {entry: 'mp4a', oti: 0x40},
    'A_MPEG/L3': {entry: 'mp4a', oti: 0x6b},
    'A_MPEG/L2': {entry: 'mp4a', oti: 0x69},
    'A_FLAC': {entry: 'fLaC', config: 'dfLa'},
    'A_OPUS': {entry: 'Opus', config: 'dOps'}
};

var SELF_CONTAINED_DREF = {
    entries: [{type: 'url ', buf: Buffer.from([0, 0, 0, 1])}]
};

// Claimed here rather than relying on mp4-remuxer.js having loaded first;
// Box.encode() throws on an unknown type.
Box.boxes.hvc1 = Box.boxes.hvc1 || Box.boxes.VisualSampleEntry;
Box.boxes.hev1 = Box.boxes.hev1 || Box.boxes.VisualSampleEntry;
Box.boxes.fLaC = Box.boxes.fLaC || Box.boxes.AudioSampleEntry;
Box.boxes.Opus = Box.boxes.Opus || Box.boxes.AudioSampleEntry;

/**
 * Resolve a Matroska CodecID to its fMP4 mapping.
 * @param {String} codecId raw TrackEntry.CodecID
 * @param {Number} type TrackType (1 video, 2 audio)
 * @returns {Object|undefined} mapping entry, if we can carry it
 */
function lookupCodec(codecId, type) {
    codecId = String(codecId);

    if (type === 1) {
        return VIDEO_CODECS[codecId];
    }

    // Older muxers write A_AAC/MPEG4/LC, A_AAC/MPEG2/LC/SBR and so forth.
    var key = codecId.indexOf('A_AAC') === 0 ? 'A_AAC' : codecId;
    return AUDIO_CODECS[key];
}

/**
 * Derive the RFC 6381 codec string MSE needs for this track.
 * @param {Object} track internal track descriptor
 * @returns {String} e.g. 'avc1.640029', 'hvc1.1.6.L93.90', 'mp4a.40.2'
 */
function codecString(track) {
    var map = track.map;
    var priv = track.codecPrivate;

    if (track.type === 1) {
        var box = Box.boxes[map.config];

        if (box && priv && priv.length > 3) {
            try {
                var info = box.decode(priv, 0, priv.length);

                // avcC yields a bare hex triplet, hvcC a leading-dot string.
                if (map.config === 'avcC') {
                    return map.entry + '.' + info.mimeCodec;
                }
                return map.entry + info.mimeCodec;
            }
            catch (ex) {
                // Fall through to the bare entry name, which isTypeSupported()
                // rejects, so a malformed record skips the track rather than
                // taking the file down.
                if (window.d) {
                    console.warn('Malformed %s, ignoring track.', map.config, ex);
                }
            }
        }
        return map.entry;
    }

    if (map.oti === 0x40) {
        // AudioSpecificConfig: the top 5 bits are the audio object type.
        var aot = priv && priv.length ? priv[0] >> 3 : 0;
        return 'mp4a.40.' + (aot > 0 && aot < 31 ? aot : 2);
    }
    if (map.oti) {
        return 'mp3';
    }
    return map.entry === 'fLaC' ? 'flac' : 'opus';
}

/**
 * @param {Number} len byte length being described
 * @returns {Array} MPEG-4 expandable length bytes
 */
function descriptorLength(len) {
    if (len < 0x80) {
        return [len];
    }
    return [
        0x80 | (len >> 21 & 0x7f),
        0x80 | (len >> 14 & 0x7f),
        0x80 | (len >> 7 & 0x7f),
        len & 0x7f
    ];
}

/**
 * @param {Number} tag descriptor tag
 * @param {Array} payload descriptor body bytes
 * @returns {Array} tag + length + body
 */
function descriptor(tag, payload) {
    return [tag].concat(descriptorLength(payload.length), payload);
}

/**
 * Body of an `esds` box. It is a full box, so mp4-box-encoding writes the
 * version/flags word itself -- this returns the bare ES_Descriptor.
 * @param {Number} oti objectTypeIndication (0x40 AAC, 0x6b MP3, ...)
 * @param {Buffer} [asc] DecoderSpecificInfo, i.e. Matroska CodecPrivate
 * @returns {Buffer} ES_Descriptor bytes
 */
function buildEsds(oti, asc) {
    // oti, streamType|upStream|reserved, bufferSizeDB, maxBitrate, avgBitrate.
    var dcd = [oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    if (asc && asc.length) {
        dcd = dcd.concat(descriptor(0x05, Array.prototype.slice.call(asc)));
    }

    var esd = [0, 0, 0]
        .concat(descriptor(0x04, dcd))
        .concat(descriptor(0x06, [0x02]));

    return Buffer.from(descriptor(0x03, esd));
}

/**
 * Build the sample entry (stsd child) describing a track.
 * @param {Object} track internal track descriptor
 * @returns {Object} mp4-box-encoding box
 */
function buildSampleEntry(track) {
    var map = track.map;
    var priv = track.codecPrivate;
    var entry = {
        type: map.entry,
        dataReferenceIndex: 1,
        children: []
    };

    if (track.type === 1) {
        entry.width = track.width;
        entry.height = track.height;
        entry.children.push({type: map.config, buffer: priv});
    }
    else {
        entry.channelCount = track.channels;
        entry.sampleSize = track.bitDepth || 16;
        // 16.16 fixed point, written as a raw uint32. Multiplication, not `<<`:
        // 44100 << 16 overflows JS's signed 32-bit bitwise range.
        entry.sampleRate = (track.sampleRate | 0) * 0x10000;

        if (map.oti) {
            entry.children.push({type: 'esds', buffer: buildEsds(map.oti, priv)});
        }
        else if (map.config && priv) {
            entry.children.push({type: map.config, buffer: priv});
        }
    }

    return entry;
}

/**
 * Build the ftyp+moov initialisation segment for a single track.
 * @param {Object} track internal track descriptor
 * @returns {Buffer} init segment
 */
function buildInitSegment(track) {
    var isVideo = track.type === 1;

    var ftyp = Box.encode({
        type: 'ftyp',
        brand: 'iso5',
        brandVersion: 0,
        compatibleBrands: ['iso5', 'iso6', 'mp41']
    });

    var moov = Box.encode({
        type: 'moov',
        mvhd: {
            timeScale: track.timescale,
            duration: 0,
            nextTrackId: 2
        },
        traks: [{
            tkhd: {
                flags: 3, // track enabled | in movie
                trackId: track.trackId,
                duration: 0,
                volume: isVideo ? 0 : 0x100,
                trackWidth: (track.width | 0) * 0x10000,
                trackHeight: (track.height | 0) * 0x10000
            },
            mdia: {
                mdhd: {
                    timeScale: track.timescale,
                    duration: 0,
                    language: track.language
                },
                hdlr: {
                    handlerType: isVideo ? 'vide' : 'soun',
                    name: isVideo ? 'VideoHandler' : 'SoundHandler'
                },
                minf: {
                    vmhd: isVideo ? {graphicsMode: 0, opcolor: [0, 0, 0]} : undefined,
                    smhd: isVideo ? undefined : {balance: 0},
                    dinf: {dref: SELF_CONTAINED_DREF},
                    stbl: {
                        stsd: {entries: [buildSampleEntry(track)]},
                        stts: emptyTable(),
                        ctts: emptyTable(),
                        stsc: emptyTable(),
                        stsz: emptyTable(),
                        stco: emptyTable(),
                        stss: emptyTable()
                    }
                }
            }
        }],
        mvex: {
            mehd: {fragmentDuration: 0},
            trexs: [{
                trackId: track.trackId,
                defaultSampleDescriptionIndex: 1,
                defaultSampleDuration: 0,
                defaultSampleSize: 0,
                defaultSampleFlags: 0
            }]
        }
    });

    return Buffer.concat([ftyp, moov]);
}

function emptyTable() {
    return {version: 0, flags: 0, entries: []};
}

/**
 * Split a Matroska Block/SimpleBlock into frames. Lacing is common on AAC and
 * MP3 audio, which pack several frames into one block.
 * @param {Buffer} data raw block payload
 * @param {Boolean} simple true for SimpleBlock (carries the keyframe flag)
 * @returns {Object|false} {trackNumber, timecode, keyframe, frames}
 */
function parseBlock(data, simple) {
    var vint = tools.readVint(data, 0);
    if (!vint) {
        return false;
    }

    var p = vint.length;
    if (data.length < p + 3) {
        return false;
    }

    var trackNumber = vint.value;
    var timecode = data.readInt16BE(p);
    var flags = data.readUInt8(p + 2);
    p += 3;

    var lacing = (flags & 0x06) >> 1;
    var frames = [];

    if (lacing === 0) {
        frames.push(data.slice(p));
    }
    else {
        var count = data.readUInt8(p++) + 1;
        var sizes = [];
        var i;

        if (lacing === 2) {
            // Fixed-size lacing: the remainder divides evenly.
            var each = (data.length - p) / count;
            for (i = 0; i < count - 1; i++) {
                sizes.push(each);
            }
        }
        else if (lacing === 1) {
            // Xiph lacing: sizes as runs of 0xff terminated by a shorter byte.
            for (i = 0; i < count - 1; i++) {
                var size = 0;
                var byte;
                do {
                    byte = data.readUInt8(p++);
                    size += byte;
                }
                while (byte === 0xff);
                sizes.push(size);
            }
        }
        else {
            // EBML lacing: first size is an unsigned vint, the rest are signed
            // deltas against the previous size.
            var first = tools.readVint(data, p);
            p += first.length;
            sizes.push(first.value);

            for (i = 1; i < count - 1; i++) {
                var delta = tools.readVint(data, p);
                p += delta.length;
                // Undo the signed-vint bias: 2^(7*len - 1) - 1
                sizes.push(sizes[i - 1] + (delta.value - (Math.pow(2, 7 * delta.length - 1) - 1)));
            }
        }

        for (i = 0; i < sizes.length; i++) {
            frames.push(data.slice(p, p + sizes[i]));
            p += sizes[i];
        }
        frames.push(data.slice(p));
    }

    return {
        trackNumber: trackNumber,
        timecode: timecode,
        // A plain Block carries no keyframe bit; BlockGroup/ReferenceBlock
        // decides, and the reader fills that in afterwards.
        keyframe: simple ? !!(flags & 0x80) : true,
        frames: frames
    };
}

/**
 * Streaming decode-order timestamper.
 *
 * Matroska stores only presentation times, so decode times are the presentation
 * times sorted ascending. Sorting per cluster is wrong when a reordering group
 * straddles a cluster boundary -- routine with HEVC B-pyramids and short
 * clusters -- and yields fragments that overlap and run backwards. Frames are
 * held in a window instead, so a decode time is fixed only once no smaller
 * presentation time can still arrive.
 *
 * @param {Number} depth frames to keep in hand; must exceed the reorder depth
 * @param {Number} defaultDuration fallback for the final frame, in ticks
 * @constructor
 */
function Reorderer(depth, defaultDuration) {
    this.depth = depth > 0 ? depth : 0;
    this.defaultDuration = defaultDuration;
    this.queue = [];    // storage order, decode time not yet fixed
    this.pool = [];     // their presentation times, ascending
    this.ready = [];    // decode time fixed, duration still pending
}

/**
 * Insert a presentation time into the ascending pool.
 * @param {Number} pts presentation time in ticks
 */
Reorderer.prototype._insert = function(pts) {
    var lo = 0;
    var hi = this.pool.length;

    while (lo < hi) {
        var mid = (lo + hi) >> 1;

        if (this.pool[mid] < pts) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }

    this.pool.splice(lo, 0, pts);
};

/**
 * Fix decode times for everything the window no longer protects.
 * @param {Boolean} all drain completely, ignoring the window
 */
Reorderer.prototype._drain = function(all) {
    while (this.queue.length > (all ? 0 : this.depth)) {
        var frame = this.queue.shift();

        // Smallest presentation time still outstanding: that is this frame's
        // slot on the decode timeline.
        frame.dts = this.pool.shift();
        frame.cts = frame.pts - frame.dts;
        this.ready.push(frame);
    }
};

/**
 * Hand back frames whose duration is known.
 * @param {Boolean} all include the tail, using defaultDuration for the last
 * @returns {Array} frames with dts, cts and duration set
 */
Reorderer.prototype._take = function(all) {
    // A frame's duration is the gap to the next decode time, so the tail has to
    // wait for more input.
    var count = all ? this.ready.length : this.ready.length - 1;

    if (count < 1) {
        return [];
    }

    var out = this.ready.splice(0, count);

    for (var i = 0; i < out.length; i++) {
        var next = i + 1 < out.length ? out[i + 1] : this.ready[0];

        out[i].duration = next ? next.dts - out[i].dts : this.defaultDuration;

        if (!(out[i].duration > 0)) {
            out[i].duration = this.defaultDuration;
        }
    }

    return out;
};

/**
 * Feed a cluster's frames in.
 * @param {Array} frames frames in storage order
 * @returns {Array} frames now fully timestamped
 */
Reorderer.prototype.push = function(frames) {
    for (var i = 0; i < frames.length; i++) {
        this.queue.push(frames[i]);
        this._insert(frames[i].pts);
    }

    this._drain(false);
    return this._take(false);
};

/**
 * Empty the window, e.g. at end of stream or before a resync discontinuity.
 * @returns {Array} every remaining frame, fully timestamped
 */
Reorderer.prototype.flush = function() {
    this._drain(true);
    return this._take(true);
};

/**
 * Build a moof+mdat media segment.
 * @param {Object} track internal track descriptor
 * @param {Array} samples timestamped samples for this fragment
 * @returns {Buffer} media segment
 */
function buildMediaSegment(track, samples) {
    var entries = [];
    var payload = [];
    var trunVersion = 0;
    var total = 0;
    var i;

    for (i = 0; i < samples.length; i++) {
        var sample = samples[i];

        if (sample.cts < 0) {
            trunVersion = 1;
        }

        entries.push({
            sampleDuration: sample.duration,
            sampleSize: sample.data.length,
            sampleFlags: sample.keyframe ? 0x2000000 : 0x1010000,
            sampleCompositionTimeOffset: sample.cts
        });

        payload.push(sample.data);
        total += sample.data.length;
    }

    var moof = {
        type: 'moof',
        mfhd: {sequenceNumber: track.sequence++},
        trafs: [{
            tfhd: {
                flags: 0x20000, // default-base-is-moof
                trackId: track.trackId
            },
            // NB: mp4-box-encoding's tfdt is 32-bit only (no version 1), so
            // baseMediaDecodeTime must stay inside 2^32. At the millisecond
            // timescale Matroska gives us that is ~49 days of media.
            tfdt: {
                baseMediaDecodeTime: samples[0].dts
            },
            trun: {
                flags: 0xf01,
                dataOffset: 8, // patched below once the moof size is known
                entries: entries,
                version: trunVersion
            }
        }]
    };

    moof.trafs[0].trun.dataOffset += Box.encodingLength(moof);

    var mdat = Buffer.allocUnsafe(8);
    mdat.writeUInt32BE(total + 8, 0);
    mdat.write('mdat', 4, 4, 'ascii');

    return Buffer.concat([Box.encode(moof), mdat].concat(payload));
}

module.exports = {
    Reorderer: Reorderer,
    lookupCodec: lookupCodec,
    codecString: codecString,
    buildInitSegment: buildInitSegment,
    buildMediaSegment: buildMediaSegment,
    parseBlock: parseBlock
};
