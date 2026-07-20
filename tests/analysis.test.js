const sharp = require("sharp");
const detectBlur = require("../src/analysis/blur");
const analyzeBrightness = require("../src/analysis/brightness");
const validateDimensions = require("../src/analysis/dimensions");
const { sha256File, computeDHash, hammingDistanceHex } = require("../src/utils/hash");

async function makeSolidImage({ width = 800, height = 600, color = { r: 128, g: 128, b: 128 } }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

async function makeNoisyImage({ width = 800, height = 600 }) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe("blur detection", () => {
  test("flags a flat, featureless image as blurry", async () => {
    const buf = await makeSolidImage({});
    const result = await detectBlur(buf);
    expect(result.isBlurry).toBe(true);
  });

  test("does not flag a high-frequency noisy image as blurry", async () => {
    const buf = await makeNoisyImage({});
    const result = await detectBlur(buf);
    expect(result.isBlurry).toBe(false);
  });
});

describe("brightness analysis", () => {
  test("flags a near-black image as low light", async () => {
    const buf = await makeSolidImage({ color: { r: 5, g: 5, b: 5 } });
    const result = await analyzeBrightness(buf);
    expect(result.isLowLight).toBe(true);
  });

  test("flags a near-white image as overexposed", async () => {
    const buf = await makeSolidImage({ color: { r: 250, g: 250, b: 250 } });
    const result = await analyzeBrightness(buf);
    expect(result.isOverexposed).toBe(true);
  });

  test("does not flag a mid-tone image", async () => {
    const buf = await makeSolidImage({ color: { r: 128, g: 128, b: 128 } });
    const result = await analyzeBrightness(buf);
    expect(result.isLowLight).toBe(false);
    expect(result.isOverexposed).toBe(false);
  });
});

describe("dimension validation", () => {
  test("rejects images below the minimum resolution", async () => {
    const buf = await makeSolidImage({ width: 100, height: 80 });
    const result = await validateDimensions(buf);
    expect(result.isValid).toBe(false);
  });

  test("accepts a normal-sized image with sane aspect ratio", async () => {
    const buf = await makeSolidImage({ width: 1200, height: 900 });
    const result = await validateDimensions(buf);
    expect(result.isValid).toBe(true);
  });

  test("flags an extreme aspect ratio", async () => {
    const buf = await makeSolidImage({ width: 2000, height: 200 });
    const result = await validateDimensions(buf);
    expect(result.isValid).toBe(false);
  });
});

describe("hashing utilities", () => {
  test("sha256 is deterministic for identical bytes", async () => {
    const buf = await makeSolidImage({});
    expect(sha256File(buf)).toBe(sha256File(buf));
  });

  test("sha256 differs for different images", async () => {
    const bufA = await makeSolidImage({ color: { r: 10, g: 10, b: 10 } });
    const bufB = await makeSolidImage({ color: { r: 250, g: 250, b: 250 } });
    expect(sha256File(bufA)).not.toBe(sha256File(bufB));
  });

  test("dHash has zero Hamming distance against itself", async () => {
    const buf = await makeSolidImage({});
    const hash = await computeDHash(buf);
    expect(hammingDistanceHex(hash, hash)).toBe(0);
  });

  test("dHash is similar (low Hamming distance) for a slightly recompressed copy", async () => {
    // dHash relies on gradient structure, so it needs a structured image (a gradient) --
    // pure random noise has no stable gradients and recompressing it legitimately produces
    // an unrelated hash, which was a bug in this test rather than in computeDHash itself.
    const gradient = Buffer.alloc(400 * 300 * 3);
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 400; x++) {
        const idx = (y * 400 + x) * 3;
        const v = Math.floor((x / 400) * 255);
        raw3(gradient, idx, v);
      }
    }
    function raw3(buffer, idx, v) {
      buffer[idx] = v;
      buffer[idx + 1] = v;
      buffer[idx + 2] = 255 - v;
    }
    const buf = await sharp(gradient, { raw: { width: 400, height: 300, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const hashA = await computeDHash(buf);
    const recompressed = await sharp(buf).jpeg({ quality: 70 }).toBuffer();
    const hashB = await computeDHash(recompressed);
    expect(hammingDistanceHex(hashA, hashB)).toBeLessThanOrEqual(8);
  });
});
