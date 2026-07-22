const sharp = require("sharp");
const { createWorker, PSM } = require("tesseract.js");

// Indian registration plate format, e.g. "KA05MN1234" or "KA05M1234".
// State code (2 letters) + RTO code (1-2 digits) + series (1-3 letters) + number (4 digits).
// We validate against the *normalized* (whitespace/hyphen stripped, uppercased) OCR text.
const PLATE_REGEX = /^([A-Z]{2})[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;
const PLATE_SUBSTRING_REGEX = /([A-Z]{2})[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/;
const PLATE_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// Real Indian state/UT RTO codes. Critical guard, not a nice-to-have: on noisy OCR
// text, a regex matching only the plate's *shape* (2 letters + digits + letters +
// 4 digits) finds false positives constantly -- any long enough blob of uppercase
// letters/digits statistically contains a shape-matching substring by chance, and
// this got measurably worse (not better) after PLATE_WHITELIST was added, because
// stripping spaces/punctuation from OCR output removed the natural word boundaries
// that had been incidentally limiting how much contiguous noise a substring scan
// could match against. Found by testing against real sample images and noticing the
// "detected" plates (e.g. "TA1ZNH3556", "ET17F2026", "NG1WL0737") didn't match the
// actual plates in the photos -- and none of "TA"/"ET"/"NG" are real state codes,
// which is what led to this fix rather than accepting the false positives at face
// value. This does not guarantee every match is a real plate (a false positive could
// still coincidentally start with a real state code), but it eliminates a whole
// class of obviously-wrong matches cheaply.
const VALID_STATE_CODES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CH", "CG", "DD", "DL", "DN", "GA", "GJ", "HR", "HP",
  "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR",
  "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UA", "UK", "UP", "WB",
]);

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
 *
 * A shape match alone (2 letters + 1-2 digits + 1-3 letters + 4 digits) is NOT
 * sufficient to accept a candidate -- see VALID_STATE_CODES comment above for why.
 * Every candidate is additionally checked against the real state-code list before
 * being accepted; a shape match with an invalid state code is treated the same as
 * no match at all.
 *
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
    if (exact && VALID_STATE_CODES.has(exact[1])) return exact[0];

    // Scan every shape-matching substring in this candidate, not just the first --
    // a noisy blob can contain more than one, and the first one found is not
    // necessarily the real plate.
    const globalMatches = candidate.matchAll(new RegExp(PLATE_SUBSTRING_REGEX, "g"));
    for (const match of globalMatches) {
      if (VALID_STATE_CODES.has(match[1])) return match[0];
    }
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

// A single, lazily-created Tesseract worker reused across every image this process
// handles, rather than paying full worker-init + language-data-load cost (previously
// the dominant share of this check's latency) on every call. tesseract.js queues
// recognize() calls made on the same worker internally, so this is safe under this
// app's QUEUE_CONCURRENCY setting -- concurrent jobs will have their OCR passes
// serialize on the shared worker rather than error, which matches what would happen
// anyway on the free-tier single-shared-vCPU hosting this runs on (see README).
//
// IMPORTANT correctness note (the reason this file looks different from an earlier
// version): tessedit_char_whitelist and tessedit_pageseg_mode are Tesseract *engine*
// parameters. They must be set via worker.setParameters() on a manually-created
// worker -- passing them into the Tesseract.recognize(image, lang, options)
// convenience wrapper's options object, as an earlier iteration of this file did,
// silently does nothing, because that options object is for *worker* options
// (logger, cachePath, etc.), not OCR engine parameters. This was caught and fixed
// before it shipped a no-op change under the guise of an improvement.
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng").catch((err) => {
      workerPromise = null; // allow a retry on the next call rather than caching a permanent failure
      throw err;
    });
  }
  return workerPromise;
}

async function runOcr(buffer, params) {
  const worker = await getWorker();
  return Promise.race([
    (async () => {
      await worker.setParameters(params);
      return worker.recognize(buffer);
    })(),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("OCR timed out")), OCR_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Vehicle number plate check: two local OCR passes (tesseract.js -- runs fully
 * on-machine, no external API calls) against the shared worker above, then
 * regex-matched against the Indian plate format.
 *
 *  1. Cropped + upscaled bottom band, PSM.SINGLE_BLOCK (appropriate for a small,
 *     relatively uniform strip) -- tried first since it's the more targeted signal
 *     for this system's stated use case (rear-vehicle field photos).
 *  2. Full frame, PSM.AUTO (Tesseract's default automatic layout detection, needed
 *     for the more complex layout a whole photo can contain) -- fallback for photos
 *     where the plate isn't in the expected region.
 *
 * Both passes restrict recognition to PLATE_WHITELIST (uppercase Latin letters and
 * digits only) via worker.setParameters(), since this function's only output is
 * "did we find a plate-shaped token" -- narrowing the character set upfront removes
 * an entire class of noise (Hindi/regional-script ad text, symbols, logos) before
 * the regex-matching step ever runs, rather than trying to filter it out after.
 *
 * A failure in one pass does not block the other (each wrapped in its own try/catch)
 * -- consistent with this system's general principle that one failing signal
 * shouldn't take down a result another signal can still provide.
 */
async function validateNumberPlate(buffer) {
  const attempts = [];
  let cropError = null;
  let fullError = null;

  try {
    const cropped = await cropBottomRegion(buffer);
    const result = await runOcr(cropped, {
      tessedit_char_whitelist: PLATE_WHITELIST,
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
    attempts.push({
      source: "cropped_bottom_region",
      text: result.data.text || "",
      confidence: result.data.confidence || 0,
    });
  } catch (err) {
    cropError = err.message;
  }

  try {
    const result = await runOcr(buffer, {
      tessedit_char_whitelist: PLATE_WHITELIST,
      tessedit_pageseg_mode: PSM.AUTO,
    });
    attempts.push({
      source: "full_frame",
      text: result.data.text || "",
      confidence: result.data.confidence || 0,
    });
  } catch (err) {
    fullError = err.message;
  }

  if (attempts.length === 0) {
    return {
      detectedText: null,
      normalizedCandidate: null,
      isValidFormat: false,
      ocrConfidence: 0,
      matchSource: null,
      error: `OCR failed: ${cropError || fullError || "unknown error"}`,
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
