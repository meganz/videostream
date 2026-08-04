// Find where the EBML decoder loses sync: compare the Cluster offsets it
// reports against a brute-force scan of the raw bytes.
//   node probe-desync.js <file.mkv>
var fs = require('fs');
var EbmlDecoder = require('ebml/lib/ebml/decoder');

var file = process.argv[2];
var buf = fs.readFileSync(file);

// Brute force: every occurrence of the Cluster ID. A few may be false
// positives inside frame data, but the real ones form the backbone.
var CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
var raw = [];
for (var i = 0; (i = buf.indexOf(CLUSTER, i)) !== -1; i++) {
    raw.push(i);
}

var dec = new EbmlDecoder();
var seen = [];
var lastElement = null;

dec.on('data', function(chunk) {
    var d = chunk[1];
    if (chunk[0] === 'start' && d.name === 'Cluster') {
        seen.push(d.start);
    }
    if (chunk[0] !== 'end') {
        lastElement = d;
    }
});
dec.on('error', function(e) { console.log('DECODER ERROR', e.message); });

dec.write(buf);

console.log('raw Cluster-ID hits : %d  (first 12: %s)', raw.length, raw.slice(0, 12).join(', '));
console.log('decoder saw         : %d  (%s)', seen.length, seen.slice(0, 12).join(', '));

// Where do they stop agreeing?
var n = Math.min(raw.length, seen.length);
var diverge = -1;
for (var k = 0; k < n; k++) {
    if (raw[k] !== seen[k]) { diverge = k; break; }
}
if (diverge === -1 && seen.length < raw.length) {
    diverge = seen.length;
}

if (diverge >= 0) {
    console.log('\nDiverges at cluster #%d', diverge);
    console.log('  raw says     offset %s', raw[diverge]);
    console.log('  decoder says %s', seen[diverge] === undefined ? '(nothing - it stopped)' : seen[diverge]);

    var prev = seen[diverge - 1];
    if (prev !== undefined) {
        // Re-read the header of the last cluster the decoder got right.
        console.log('\nLast good cluster #%d at %s:', diverge - 1, prev);
        console.log('  bytes: %s', buf.toString('hex', prev, prev + 16));
    }
    var at = raw[diverge];
    console.log('\nBytes around the cluster the decoder missed (%s):', at);
    console.log('  before: %s', buf.toString('hex', Math.max(0, at - 24), at));
    console.log('  at    : %s', buf.toString('hex', at, at + 16));
}
else {
    console.log('\nNo divergence - decoder tracked every cluster.');
}

console.log('\nLast element the decoder produced: %s tag=%s start=%s end=%s size=%s type=%s',
    lastElement && lastElement.name, lastElement && lastElement.tagStr,
    lastElement && lastElement.start, lastElement && lastElement.end,
    lastElement && lastElement.dataSize, lastElement && lastElement.type);
