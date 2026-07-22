const sharp = require("sharp");
const Tesseract = require("tesseract.js");

// Indian registration plate format, e.g. "KA05MN1234" or "KA05M1234".
// State code (2 letters) + RTO code (1-2 digits) + series (1-3 letters) + number (4 digits).
// We validate against the *normalized* (whitespace/hyphen stripped, uppercased) OCR text.
const PLATE_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;
const PLATE_SUBSTRING_REGEX = /[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/;

const OCR_TIMEOUT_MS = 20000;
// Fraction of image height cropped from the bottom for the second OCR pass.
// Rear-vehicle field photos (the brief's stated use case) almost always place the
// plate in this region; cropping to it removes competing text (ad banners, signage)
// that otherwise dominates full-frame OCR on cluttered images.
// Chosen empirically, not guessed: tested at 0.35/0.42/0.50 against real sample
// photos (ad-wrapped auto-rickshaws, where the plate sits noticeably higher than on
// a plain vehicle photo because of the tall ad banner above it) -- 0.35 cropped the
// plate right at the boundary in more than one sample; 0.42 reliably captured it with
// margin without cropping away so little clutter that it stops helping.
const BOTTOM_CROP_FRACTION = 0.42;
// Cap on upscale target width -- upscaling small text measurably helps Tesseract's
// character segmentation, but without a cap a very high-resolution source image would
// produce an enormous (slow, memory-heavy) crop for no further accuracy benefit.
const MAX_CROP_WIDTH = 2400;

function normalizeCandidate(text) {
  return text.replace(/[\s\-.:]/g, "").toUpperCase();
}

/**
 * Scans OCR output for a plate-shaped token: line by line (OCR naturally breaks on
 * newlines) and as one concatenated block (OCR sometimes splits a plate across
 * "words" with spurious spaces that per-line scanning alone would miss).
 * Pure and dependency-free by design -- unit-tested directly with fixture strings,
 * no OCR engine needed to verify the matching logic itself (see tests/numberPlate.test.js).
 */
function findPlateMatch(rawText) {
  if (!rawText) return null;

  const candidates = new Set();
  rawText
    .split(/\r?\n/)
    .map((line) => normalizeCandidate(line))
    .filter(Boolean)
    .forEach((c) => candidates.add(c));
  candidates.add(normalizeCandidate(rawText));

  for (const candidate of candidates) {
    const exact = candidate.match(PLATE_REGEX);
    if (exact) return exact[0];
    const substring = candidate.match(PLATE_SUBSTRING_REGEX);
    if (substring) return substring[0];
  }
  return null;
}

/**
 * Crops the bottom band of the image and upscales it before OCR. Cheap relative to
 * a second full OCR pass (sharp's crop/resize is native-code and fast), and targets
 * the one region a rear-vehicle plate photo almost always contains it in.
 */
async function cropBottomRegion(buffer) {
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;
  if (!width || !height) throw new Error("Could not read image dimensions for cropping");

  const cropHeight = Math.max(1, Math.round(height * BOTTOM_CROP_FRACTION));
  const top = height - cropHeight;
  const targetWidth = Math.min(width * 3, MAX_CROP_WIDTH);

  return sharp(buffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .resize({ width: Math.round(targetWidth) })
    .sharpen()
    .normalize()
    .toBuffer();
}

async function runOcr(buffer, extraOptions = {}) {
  return Promise.race([
    // Restrict recognition to characters a valid plate can actually contain.
    // Default tesseract.js tries to recognize any script/symbol it sees, which on a
    // cluttered rear-vehicle photo (ad banners, Hindi/regional-script text, logos)
    // produces a flood of noise that a plate-shaped regex then has to fish a signal
    // out of. Since this function's only output is "did we find a plate-shaped
    // token," narrowing the character set upfront is a legitimate, low-risk way to
    // cut that noise rather than trying to filter it after the fact.
    Tesseract.recognize(buffer, "eng", {
      logger: () => {}, // silence per-tile progress logs
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ...extraOptions,
    }),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("OCR timed out")), OCR_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Vehicle number plate check: two independent local OCR passes (tesseract.js -- runs
 * fully on-machine, no external API calls), then regex-matched against the Indian
 * plate format.
 *
 *  1. Full frame -- catches plates wherever they happen to sit in the photo.
 *  2. Cropped + upscaled bottom band -- targets the region a rear-vehicle photo
 *     (this system's stated use case) almost always has the plate in, with
 *     competing text (ad banners, signage, background clutter) cropped out and the
 *     small plate text enlarged before OCR sees it.
 *
 * The cropped pass is tried first since it's the more targeted signal for this
 * specific use case; the full-frame pass is the fallback for photos where the plate
 * isn't in the expected region. Both passes run regardless of which succeeds first
 * (not short-circuited), so a failure in one never blocks a result from the other --
 * consistent with this system's general principle that one failing signal shouldn't
 * take down a result that another signal can still provide.
 *
 * Trade-off: both passes are issued concurrently (not sequentially awaited), so on a
 * multi-core machine wall-clock latency approaches the slower of the two rather than
 * their sum. In practice, on the free-tier single-shared-vCPU hosting this system is
 * deployed on (see README), two concurrent CPU-bound OCR jobs mostly serialize anyway
 * -- so expect latency closer to double a single pass in this specific deployment,
 * even though the code doesn't force that serialization itself. A deliberate
 * accuracy-for-time trade given OCR was already the slowest check by a wide margin
 * either way (see README benchmark section).
 */
async function validateNumberPlate(buffer) {
  const [fullResult, cropResult] = await Promise.allSettled([
    runOcr(buffer),
    // PSM 6 = "assume a single uniform block of text". Reasonable for the cropped
    // bottom band (a small, relatively uniform strip) in a way it wouldn't be for the
    // full frame, whose layout (ad banner, sky, road, multiple text blocks at
    // different scales) is exactly the kind of complex page Tesseract's default
    // automatic segmentation (PSM 3) is designed for instead.
    cropBottomRegion(buffer).then((cropped) => runOcr(cropped, { tessedit_pageseg_mode: "6" })),
  ]);

  const attempts = [];
  if (cropResult.status === "fulfilled") {
    attempts.push({
      source: "cropped_bottom_region",
      text: cropResult.value.data.text || "",
      confidence: cropResult.value.data.confidence || 0,
    });
  }
  if (fullResult.status === "fulfilled") {
    attempts.push({
      source: "full_frame",
      text: fullResult.value.data.text || "",
      confidence: fullResult.value.data.confidence || 0,
    });
  }

  if (attempts.length === 0) {
    const error =
      (fullResult.status === "rejected" && fullResult.reason.message) ||
      (cropResult.status === "rejected" && cropResult.reason.message) ||
      "OCR failed";
    return {
      detectedText: null,
      normalizedCandidate: null,
      isValidFormat: false,
      ocrConfidence: 0,
      matchSource: null,
      error: `OCR failed: ${error}`,
    };
  }

  // Cropped-region attempt is checked first (see function doc for why); first match wins.
  for (const attempt of attempts) {
    const matched = findPlateMatch(attempt.text);
    if (matched) {
      return {
        detectedText: attempt.text.trim().slice(0, 200) || null,
        normalizedCandidate: matched,
        isValidFormat: true,
        ocrConfidence: Number(attempt.confidence.toFixed(2)),
        matchSource: attempt.source,
      };
    }
  }

  // Neither pass found a plate-shaped token -- surface the higher-confidence pass's
  // raw text for diagnostics rather than picking arbitrarily.
  const best = attempts.sort((a, b) => b.confidence - a.confidence)[0];
  return {
    detectedText: best.text.trim().slice(0, 200) || null,
    normalizedCandidate: null,
    isValidFormat: false,
    ocrConfidence: Number(best.confidence.toFixed(2)),
    matchSource: null,
  };
}

module.exports = validateNumberPlate;
module.exports.findPlateMatch = findPlateMatch;
