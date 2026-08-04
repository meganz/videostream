// Stream an .mkv through the raw EBML decoder and print the element sequence,
// to see where parsing goes off the rails.  node probe-ebml.js <file> [maxEvents]
var fs = require('fs');
var EbmlDecoder = require('ebml/lib/ebml/decoder');

var file = process.argv[2];
var max = (process.argv[3] | 0) || 400;

var dec = new EbmlDecoder();
var n = 0;
var depth = 0;
var clusters = 0;
var stop = false;
var quiet = false;

dec.on('data', function(chunk) {
    if (stop) {
        return;
    }
    var state = chunk[0];
    var d = chunk[1];

    if (state === 'end') {
        depth--;
        return;
    }

    var interesting = d.name === 'Cluster' || d.name === 'Cues' || d.name === 'unknown'
        || d.name === 'Segment' || d.name === 'Tracks' || d.name === 'SeekHead'
        || d.name === 'Void' || d.name === 'CRC-32' || d.name === 'Tags'
        || d.name === 'Attachments' || d.name === 'Chapters';

    if (d.name === 'Cluster' && state === 'start') {
        clusters++;
    }

    // Show everything at the top two levels plus anything unrecognised, but
    // stay quiet about the thousands of blocks inside clusters.
    if (!quiet && (interesting || depth <= 1)) {
        console.log('%s%s %s  tag=%s start=%s end=%s size=%s type=%s',
            '  '.repeat(Math.max(0, depth)), state, d.name, d.tagStr, d.start, d.end, d.dataSize, d.type);
        if (++n > max) {
            console.log('--- silencing output; still counting clusters ---');
            quiet = true;
        }
    }

    if (state === 'start') {
        depth++;
    }
});

dec.on('error', function(err) {
    console.log('DECODER ERROR:', err && err.message);
});

var rs = fs.createReadStream(file, {highWaterMark: 65536});
rs.on('data', function(c) {
    if (!stop) {
        try { dec.write(c); }
        catch (ex) { console.log('WRITE THREW:', ex.message); stop = true; }
    }
});
rs.on('end', function() {
    console.log('--- eof. clusters seen: ' + clusters);
});

