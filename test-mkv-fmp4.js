// Round-trip sanity test for mkv-fmp4.js — run with plain node from the videostream repo root.
var assert = require('assert');
var Box = require('mp4-box-encoding');

// bundle/build-browserify.js rewrites `Box = exports` into
// `Box=exports;Box.boxes=boxes`, so Box.boxes only exists inside the built
// bundle. Replicate that here so the module sees the same shape it will in
// the browser.
Box.boxes = Box.boxes || require('mp4-box-encoding/boxes');

var mkv = require('./mkv-fmp4.js');

function ok(name) {
    console.log('  ok - ' + name);
}

// ---------------------------------------------------------------- codec map
assert.strictEqual(mkv.lookupCodec('V_MPEG4/ISO/AVC', 1).entry, 'avc1');
assert.strictEqual(mkv.lookupCodec('V_MPEGH/ISO/HEVC', 1).entry, 'hvc1');
assert.strictEqual(mkv.lookupCodec('A_AAC', 2).entry, 'mp4a');
assert.strictEqual(mkv.lookupCodec('A_AAC/MPEG4/LC/SBR', 2).entry, 'mp4a', 'legacy AAC CodecID variants');
assert.strictEqual(mkv.lookupCodec('A_MPEG/L3', 2).oti, 0x6b);
// The whole point of the ticket: these must NOT map, so they fall back to video-only.
assert.strictEqual(mkv.lookupCodec('A_DTS', 2), undefined, 'DTS must be unsupported');
assert.strictEqual(mkv.lookupCodec('A_AC3', 2), undefined, 'AC-3 must be unsupported');
assert.strictEqual(mkv.lookupCodec('A_EAC3', 2), undefined);
assert.strictEqual(mkv.lookupCodec('A_TRUEHD', 2), undefined);
ok('codec mapping (incl. DTS/AC-3 rejection)');

// ------------------------------------------------------------ init segment
// A minimal but structurally valid AVCDecoderConfigurationRecord.
var avcC = Buffer.from([0x01, 0x64, 0x00, 0x29, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x29, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80]);

var videoTrack = {
    trackId: 1, type: 1, timescale: 1000, language: 0x55c4,
    width: 1920, height: 1080, codecPrivate: avcC,
    map: mkv.lookupCodec('V_MPEG4/ISO/AVC', 1), sequence: 1
};

var init = mkv.buildInitSegment(videoTrack);
var ftyp = Box.decode(init, 0);
assert.strictEqual(ftyp.type, 'ftyp');
assert.strictEqual(ftyp.brand, 'iso5');

var moov = Box.decode(init, ftyp.length);
assert.strictEqual(moov.type, 'moov');
assert.strictEqual(moov.length, init.length - ftyp.length, 'moov must consume the rest of the init segment');
assert.strictEqual(moov.mvhd.timeScale, 1000);
assert.strictEqual(moov.traks.length, 1);

var trak = moov.traks[0];
assert.strictEqual(trak.tkhd.trackId, 1);
assert.strictEqual(trak.tkhd.trackWidth >>> 16, 1920, 'tkhd width is 16.16 fixed point');
assert.strictEqual(trak.mdia.hdlr.handlerType, 'vide');
assert.strictEqual(trak.mdia.mdhd.timeScale, 1000);

var stsd = trak.mdia.minf.stbl.stsd;
assert.strictEqual(stsd.entries.length, 1);
assert.strictEqual(stsd.entries[0].type, 'avc1');
assert.strictEqual(stsd.entries[0].width, 1920);
assert.strictEqual(stsd.entries[0].height, 1080);
assert.ok(stsd.entries[0].avcC, 'avc1 must carry an avcC child');
assert.strictEqual(stsd.entries[0].avcC.buffer.toString('hex'), avcC.toString('hex'), 'CodecPrivate must survive verbatim');
assert.strictEqual(stsd.entries[0].avcC.mimeCodec, '640029', 'mimeCodec drives the MSE codec string');
assert.strictEqual(moov.mvex.trexs[0].trackId, 1);
ok('video init segment (ftyp+moov) round-trips');

// --------------------------------------------------------- audio init/esds
var asc = Buffer.from([0x12, 0x10]); // AAC-LC, 44.1kHz, stereo
var audioTrack = {
    trackId: 2, type: 2, timescale: 1000, language: 0x55c4,
    channels: 2, sampleRate: 44100, bitDepth: 16, codecPrivate: asc,
    map: mkv.lookupCodec('A_AAC', 2), sequence: 1
};
var ainit = mkv.buildInitSegment(audioTrack);
var amoov = Box.decode(ainit, Box.decode(ainit, 0).length);
var aentry = amoov.traks[0].mdia.minf.stbl.stsd.entries[0];
assert.strictEqual(aentry.type, 'mp4a');
assert.strictEqual(aentry.channelCount, 2);
assert.strictEqual(aentry.sampleRate >>> 16, 44100, 'sampleRate is 16.16 fixed point');
assert.strictEqual(amoov.traks[0].mdia.hdlr.handlerType, 'soun');
assert.ok(aentry.esds, 'mp4a must carry esds');
// esds.decode walks the descriptor tree; if our hand-rolled descriptors were
// malformed this is where it falls over.
assert.strictEqual(aentry.esds.mimeCodec, '40.2', 'AAC-LC must decode to mp4a.40.2');
ok('audio init segment + hand-rolled esds decodes to mp4a.40.2');

// ------------------------------------------------------------ block parsing
// SimpleBlock: track 1 (vint 0x81), timecode +0x0010, flags 0x80 (keyframe)
var block = Buffer.concat([Buffer.from([0x81, 0x00, 0x10, 0x80]), Buffer.from([0xaa, 0xbb, 0xcc])]);
var parsed = mkv.parseBlock(block, true);
assert.strictEqual(parsed.trackNumber, 1);
assert.strictEqual(parsed.timecode, 16);
assert.strictEqual(parsed.keyframe, true);
assert.strictEqual(parsed.frames.length, 1);
assert.strictEqual(parsed.frames[0].toString('hex'), 'aabbcc');

// Negative timecode must stay signed (B-frames before the cluster timecode).
var neg = mkv.parseBlock(Buffer.from([0x81, 0xff, 0xf0, 0x00, 0x01]), true);
assert.strictEqual(neg.timecode, -16, 'block timecode is a signed int16');
assert.strictEqual(neg.keyframe, false);

// Xiph lacing: 3 frames of 2 bytes each -> sizes [2,2], remainder is frame 3.
var xiph = Buffer.concat([
    Buffer.from([0x81, 0x00, 0x00, 0x02]), // flags 0x02 = Xiph lacing
    Buffer.from([0x02]),                   // frame count - 1 = 2 -> 3 frames
    Buffer.from([0x02, 0x02]),             // Xiph sizes
    Buffer.from([1, 2, 3, 4, 5, 6])
]);
var laced = mkv.parseBlock(xiph, true);
assert.strictEqual(laced.frames.length, 3, 'Xiph lacing must split AAC/MP3 blocks');
assert.deepStrictEqual(Array.from(laced.frames[0]), [1, 2]);
assert.deepStrictEqual(Array.from(laced.frames[2]), [5, 6]);

// Fixed-size lacing (flags 0x04): 2 frames of 3 bytes.
var fixed = mkv.parseBlock(Buffer.concat([
    Buffer.from([0x81, 0x00, 0x00, 0x04, 0x01]),
    Buffer.from([1, 2, 3, 4, 5, 6])
]), true);
assert.strictEqual(fixed.frames.length, 2);
assert.deepStrictEqual(Array.from(fixed.frames[1]), [4, 5, 6]);
ok('SimpleBlock parsing: signed timecode, Xiph + fixed lacing');

// -------------------------------------------------------- DTS derivation
// No reordering -> dts == pts, cts == 0.
var linear = [{pts: 0}, {pts: 40}, {pts: 80}];
mkv.assignTimestamps(linear, 40);
assert.deepStrictEqual(linear.map(function(s) { return s.dts; }), [0, 40, 80]);
assert.deepStrictEqual(linear.map(function(s) { return s.cts; }), [0, 0, 0]);
assert.deepStrictEqual(linear.map(function(s) { return s.duration; }), [40, 40, 40]);

// Classic IPBB storage order: presentation order is 0,40,80,120 but stored
// I(0) P(120) B(40) B(80). DTS must come out monotonic with cts making up
// the difference — this is the bit that causes stutter when done wrong.
var reordered = [{pts: 0}, {pts: 120}, {pts: 40}, {pts: 80}];
mkv.assignTimestamps(reordered, 40);
assert.deepStrictEqual(reordered.map(function(s) { return s.dts; }), [0, 40, 80, 120], 'DTS must be monotonic');
assert.deepStrictEqual(reordered.map(function(s) { return s.cts; }), [0, 80, -40, -40]);
for (var i = 0; i < reordered.length; i++) {
    assert.strictEqual(reordered[i].dts + reordered[i].cts, reordered[i].pts, 'dts+cts must reconstruct pts');
}
ok('DTS derivation for B-frame reordering');

// ---------------------------------------------------------- media segment
var samples = [
    {pts: 0, keyframe: true, data: Buffer.from([1, 2, 3, 4])},
    {pts: 40, keyframe: false, data: Buffer.from([5, 6])}
];
mkv.assignTimestamps(samples, 40);
var seg = mkv.buildMediaSegment(videoTrack, samples);

// NB: mp4-box-encoding leaves trun.decode/tfdt.decode unimplemented upstream,
// so a moof cannot be round-tripped through Box.decode. Verify it structurally
// instead, which is what actually matters to the browser's demuxer.
var moofHdr = Box.readHeaders(seg, 0);
assert.strictEqual(moofHdr.type, 'moof');
assert.strictEqual(videoTrack.sequence, 2, 'sequence number must advance');

var mdatLen = seg.readUInt32BE(moofHdr.length);
assert.strictEqual(seg.toString('ascii', moofHdr.length + 4, moofHdr.length + 8), 'mdat');
assert.strictEqual(mdatLen, 8 + 6, 'mdat size = header + payload');
assert.strictEqual(seg.length, moofHdr.length + mdatLen, 'segment is exactly moof+mdat');

// The trun dataOffset must point at the first payload byte, measured from the
// start of the moof (default-base-is-moof). Off-by-one here = instant decode error.
var trunAt = seg.indexOf('trun', 0, 'ascii');
assert.ok(trunAt > 0 && trunAt < moofHdr.length, 'trun must live inside the moof');
var sampleCount = seg.readUInt32BE(trunAt + 8);      // after fourcc + version/flags
var dataOffset = seg.readInt32BE(trunAt + 12);
assert.strictEqual(sampleCount, 2, 'trun sample count');
assert.strictEqual(dataOffset, moofHdr.length + 8, 'trun.dataOffset must land on the mdat payload');
assert.strictEqual(seg.toString('hex', dataOffset, dataOffset + 4), '01020304', 'first sample lands at dataOffset');

// tfdt baseMediaDecodeTime must be the first sample's DTS.
var tfdtAt = seg.indexOf('tfdt', 0, 'ascii');
assert.strictEqual(seg.readUInt32BE(tfdtAt + 8), 0, 'tfdt baseMediaDecodeTime');

// Sample flags: first is a sync sample, second is not.
assert.strictEqual(seg.readUInt32BE(trunAt + 16 + 8), 0x2000000, 'keyframe sample flags');
assert.strictEqual(seg.readUInt32BE(trunAt + 16 + 16 + 8), 0x1010000, 'non-keyframe sample flags');
ok('media segment moof+mdat layout, trun.dataOffset and sample flags');

console.log('\nAll mkv-fmp4 checks passed.');
