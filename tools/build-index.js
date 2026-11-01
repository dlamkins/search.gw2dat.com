// Packs a data directory of pHash digests into the index.bin.gz the site searches.
//
//   node tools/build-index.js <data directory>
//
// Input is laid out as <data directory>/<width>x<height>/<asset id>, one raw digest per file.
// Output is gzipped, little-endian, with the entries ordered by asset id:
//
//   uint32                 entry count
//   uint32[count]          asset id, as the difference from the previous entry's id
//   uint16[count * 2]      width, height
//   uint8[count * 40]      digest

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIGEST_SIZE = 40;

function readEntries(dataPath) {
    const entries = [];

    for (const dimension of fs.readdirSync(dataPath, { withFileTypes: true })) {
        const match = dimension.isDirectory() && /^(\d+)x(\d+)$/.exec(dimension.name);

        if (!match) {
            console.warn(`Skipping ${dimension.name}`);
            continue;
        }

        const dimensionPath = path.join(dataPath, dimension.name);

        for (const file of fs.readdirSync(dimensionPath)) {
            if (!/^\d+$/.test(file)) {
                console.warn(`Skipping ${dimension.name}/${file}`);
                continue;
            }

            const digest = fs.readFileSync(path.join(dimensionPath, file));

            if (digest.length !== DIGEST_SIZE) {
                throw new Error(`${dimension.name}/${file} is ${digest.length} bytes, expected ${DIGEST_SIZE}`);
            }

            entries.push({ asset: Number(file), width: Number(match[1]), height: Number(match[2]), digest });
        }
    }

    return entries.sort((a, b) => a.asset - b.asset);
}

function packEntries(entries) {
    const count = entries.length;
    const packed = Buffer.alloc(4 + count * (8 + DIGEST_SIZE));
    const dimensionsStart = 4 + count * 4;
    const digestsStart = 4 + count * 8;
    let previousAsset = 0;

    packed.writeUInt32LE(count, 0);

    entries.forEach(({ asset, width, height, digest }, i) => {
        packed.writeUInt32LE(asset - previousAsset, 4 + i * 4);
        packed.writeUInt16LE(width, dimensionsStart + i * 4);
        packed.writeUInt16LE(height, dimensionsStart + i * 4 + 2);
        digest.copy(packed, digestsStart + i * DIGEST_SIZE);
        previousAsset = asset;
    });

    return packed;
}

const dataPath = process.argv[2];

if (!dataPath) {
    console.error('Usage: node tools/build-index.js <data directory>');
    process.exit(1);
}

const entries = readEntries(dataPath);
const compressed = zlib.gzipSync(packEntries(entries), { level: 9 });
const outputPath = path.join(__dirname, '..', 'index.bin.gz');

fs.writeFileSync(outputPath, compressed);
console.log(`Packed ${entries.length} digests into ${outputPath} (${compressed.length} bytes)`);
