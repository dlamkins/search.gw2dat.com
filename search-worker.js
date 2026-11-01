importScripts('phash.js');

const MIN_SCORE = 0.87;
const MAX_RESULTS = 200;
const MAX_SIZE_RATIO = 2; // Assets more than this many times larger than the image are skipped

let indexPromise = null;
let indexLoaded = false;

function getIndex() {
    if (indexPromise === null) {
        indexPromise = loadIndex().catch(error => {
            indexPromise = null; // Let the next search retry
            throw error;
        });
    }

    return indexPromise;
}

async function fetchIndexBytes() {
    const response = await fetch('index.bin.gz');

    if (!response.ok) {
        throw new Error(`Failed to load index: ${response.status}`);
    }

    const bytes = await response.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, 2);

    // A host may already have decoded this for us if it served it with Content-Encoding.
    if (signature[0] !== 0x1f || signature[1] !== 0x8b) {
        return bytes;
    }

    const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));

    return new Response(decompressed).arrayBuffer();
}

// See tools/build-index.js for the file layout.
async function loadIndex() {
    const bytes = await fetchIndexBytes();
    const count = new Uint32Array(bytes, 0, 1)[0];
    const idDeltas = new Uint32Array(bytes, 4, count);
    const dimensions = new Uint16Array(bytes, 4 + count * 4, count * 2);
    const digests = new Uint8Array(bytes, 4 + count * 8, count * DIGEST_SIZE);

    const assets = new Uint32Array(count);
    const centered = new Float32Array(count * DIGEST_SIZE);
    const energies = new Float32Array(count);
    let asset = 0;

    for (let i = 0; i < count; i++) {
        asset += idDeltas[i];
        assets[i] = asset;

        const digest = digests.subarray(i * DIGEST_SIZE, (i + 1) * DIGEST_SIZE);
        energies[i] = centerDigest(digest, centered, i * DIGEST_SIZE);
    }

    indexLoaded = true;

    return { count, assets, dimensions, centered, energies };
}

async function decodeImage(file) {
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    // The stored digests were made from images flattened onto black.
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    return { rgba: context.getImageData(0, 0, width, height).data, width, height };
}

function search(index, digest, width, height) {
    const { count, assets, dimensions, centered, energies } = index;
    const maxWidth = width * MAX_SIZE_RATIO;
    const maxHeight = height * MAX_SIZE_RATIO;
    const minScoreSquared = MIN_SCORE * MIN_SCORE;

    // Holding the digest twice over lets each offset read a run without wrapping.
    const query = new Float32Array(DIGEST_SIZE * 2);
    const queryEnergy = centerDigest(digest, query, 0);
    query.copyWithin(DIGEST_SIZE, 0, DIGEST_SIZE);

    const results = [];

    for (let i = 0; i < count; i++) {
        if (dimensions[i * 2] > maxWidth || dimensions[i * 2 + 1] > maxHeight) {
            continue;
        }

        const start = i * DIGEST_SIZE;
        let peak = 0;

        for (let offset = 0; offset < DIGEST_SIZE; offset++) {
            let product = 0;

            for (let k = 0; k < DIGEST_SIZE; k++) {
                product += query[k + offset] * centered[start + k];
            }

            if (product > peak) {
                peak = product;
            }
        }

        const scoreSquared = peak * peak / (queryEnergy * energies[i]);

        if (scoreSquared > minScoreSquared) {
            results.push({ asset: assets[i], score: Math.sqrt(scoreSquared) });
        }
    }

    return results.sort((a, b) => b.score - a.score);
}

self.onmessage = async ({ data: { searchId, file } }) => {
    let index = null;

    try {
        if (!indexLoaded) {
            self.postMessage({ searchId, status: 'downloading' });
            index = await getIndex();
            self.postMessage({ searchId, status: 'searching' });
        } else {
            index = await getIndex();
        }

        const { rgba, width, height } = await decodeImage(file);
        const matches = search(index, computeDigest(rgba, width, height), width, height);

        self.postMessage({ searchId, results: matches.slice(0, MAX_RESULTS), total: matches.length });
    } catch (error) {
        console.error(error);
        self.postMessage({ searchId, error: index === null ? 'index' : 'image' });
    }
};

getIndex().catch(() => { }); // Start downloading before the first search
