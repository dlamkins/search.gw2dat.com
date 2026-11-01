// Port of Shipwreck.Phash's ImagePhash.ComputeDigest and GetCrossCorrelation.
const DIGEST_SIZE = 40;
const NUMBER_OF_ANGLES = 180;
const BLUR_RADIUS = 3;
const BLUR_SIGMA = 3.5;

const BLUR_KERNEL = Float32Array.from({ length: 2 * BLUR_RADIUS + 1 }, (_, i) => {
    const distance = i - BLUR_RADIUS;
    return Math.exp(-distance * distance / (2 * BLUR_SIGMA * BLUR_SIGMA));
});

function toLuminance(rgba, width, height) {
    const luminance = new Uint8Array(width * height);

    for (let i = 0; i < luminance.length; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];

        luminance[i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    }

    return luminance;
}

function blurLine(source, sourceStart, step, length, target) {
    for (let i = 0; i < length; i++) {
        let total = 0;
        let weight = 0;

        for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
            const position = i + k;

            if (position >= 0 && position < length) {
                const coefficient = BLUR_KERNEL[k + BLUR_RADIUS];
                total += source[sourceStart + position * step] * coefficient;
                weight += coefficient;
            }
        }

        target[i] = total / weight;
    }
}

function blur(luminance, width, height) {
    const horizontal = new Float32Array(width * height);
    const blurred = new Float32Array(width * height);
    const line = new Float32Array(Math.max(width, height));

    for (let y = 0; y < height; y++) {
        blurLine(luminance, y * width, 1, width, line);
        horizontal.set(line.subarray(0, width), y * width);
    }

    for (let x = 0; x < width; x++) {
        blurLine(horizontal, x, width, height, line);

        for (let y = 0; y < height; y++) {
            blurred[x + y * width] = line[y];
        }
    }

    return blurred;
}

function roundToNearest(value) {
    return Math.floor(value + (value >= 0 ? 0.5 : -0.5));
}

function findRadonProjections(image, width, height) {
    const lines = NUMBER_OF_ANGLES;
    const maxSide = Math.max(width, height);
    const centerX = roundToNearest(width / 2);
    const centerY = roundToNearest(height / 2);
    const region = new Float32Array(lines * maxSide);
    const pixelsPerLine = new Int32Array(lines);

    const addPixel = (line, position, x, y) => {
        region[line + position * lines] = image[x + y * width];
        pixelsPerLine[line]++;
    };

    for (let i = 0; i < lines / 4 + 1; i++) {
        const slope = Math.tan(i * Math.PI / lines);

        for (let j = 0; j < maxSide; j++) {
            const offset = roundToNearest(slope * (j - centerX));

            if (offset + centerY >= 0 && offset + centerY < height && j < width) {
                addPixel(i, j, j, offset + centerY);
            }

            if (offset + centerX >= 0 && offset + centerX < width && i !== lines / 4 && j < height) {
                addPixel(lines / 2 - i, j, offset + centerX, j);
            }
        }
    }

    let mirror = 0;

    for (let i = 3 * lines / 4; i < lines; i++) {
        const slope = Math.tan(i * Math.PI / lines);

        for (let j = 0; j < maxSide; j++) {
            const offset = roundToNearest(slope * (j - centerX));

            if (offset + centerY >= 0 && offset + centerY < height && j < width) {
                addPixel(i, j, j, offset + centerY);
            }

            if (centerY - offset >= 0 && centerY - offset < width
                && 2 * centerY - j >= 0 && 2 * centerY - j < height
                && i !== 3 * lines / 4) {
                addPixel(i - mirror, j, centerY - offset, 2 * centerY - j);
            }
        }

        mirror += 2;
    }

    return { region, pixelsPerLine };
}

function computeFeatureVector({ region, pixelsPerLine }, maxSide) {
    const lines = pixelsPerLine.length;
    const features = new Float32Array(lines);
    let sum = 0;
    let sumOfSquares = 0;

    for (let i = 0; i < lines; i++) {
        const count = pixelsPerLine[i];
        let lineSum = 0;
        let lineSumOfSquares = 0;

        for (let j = 0; j < maxSide; j++) {
            const value = region[i + j * lines];
            lineSum += value;
            lineSumOfSquares += value * value;
        }

        features[i] = count > 0 ? lineSumOfSquares / count - lineSum * lineSum / (count * count) : 0;
        sum += features[i];
        sumOfSquares += features[i] * features[i];
    }

    const mean = sum / lines;
    const scale = 1 / Math.sqrt(sumOfSquares / lines - sum * sum / (lines * lines));

    return features.map(feature => (feature - mean) * scale);
}

function computeDct(features) {
    const length = features.length;
    const coefficients = new Float32Array(DIGEST_SIZE);
    let max = 0;
    let min = 0;

    for (let i = 0; i < DIGEST_SIZE; i++) {
        let sum = 0;

        for (let j = 0; j < length; j++) {
            sum += features[j] * Math.cos((2 * j + 1) * i * Math.PI / (2 * length));
        }

        coefficients[i] = sum / Math.sqrt(length) * (i === 0 ? 1 : Math.SQRT2);
        max = Math.max(max, coefficients[i]);
        min = Math.min(min, coefficients[i]);
    }

    const scale = 255 / (max - min);

    return Uint8Array.from(coefficients, coefficient => Math.trunc((coefficient - min) * scale));
}

function computeDigest(rgba, width, height) {
    const image = blur(toLuminance(rgba, width, height), width, height);

    let max = 0;
    for (const value of image) {
        max = Math.max(max, value);
    }

    for (let i = 0; i < image.length; i++) {
        image[i] /= max;
    }

    const projections = findRadonProjections(image, width, height);

    return computeDct(computeFeatureVector(projections, Math.max(width, height)));
}

function centerDigest(digest, target, targetStart) {
    let sum = 0;

    for (let i = 0; i < DIGEST_SIZE; i++) {
        sum += digest[i];
    }

    const mean = sum / DIGEST_SIZE;
    let energy = 0;

    for (let i = 0; i < DIGEST_SIZE; i++) {
        const value = digest[i] - mean;
        target[targetStart + i] = value;
        energy += value * value;
    }

    return energy;
}
