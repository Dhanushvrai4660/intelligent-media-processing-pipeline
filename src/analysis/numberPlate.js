const Tesseract = require("tesseract.js");

// Indian registration plate format, e.g. "KA05MN1234" or "KA05M1234".
// State code (2 letters) + RTO code (1-2 digits) + series (1-3 letters) + number (4 digits).
// We validate against the *normalized* (whitespace/hyphen stripped, uppercased) OCR text.
const PLATE_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;

function normalizeCandidate(text) {
  return text.replace(/[\s\-.:]/g, "").toUpperCase();
}

/**
 * Vehicle number plate check: run local OCR (tesseract.js -- runs fully on-machine,
 * no external API calls) over the full image, then scan the extracted text for a
 * substring matching the Indian plate format.
 *
 * Deliberate simplification: we OCR the whole frame rather than first localizing a
 * plate bounding box. That keeps the pipeline dependency-light (no extra detector
 * model) at the cost of lower OCR accuracy on cluttered images -- called out in the
 * README trade-offs. For a production system this would be a two-stage pipeline:
 * plate localization (small object-detection model) -> crop -> OCR.
 */
async function validateNumberPlate(buffer) {
  let rawText = "";
  let ocrConfidence = 0;
  const OCR_TIMEOUT_MS = 20000;

  try {
    const result = await Promise.race([
      Tesseract.recognize(buffer, "eng", { logger: () => {} }), // silence per-tile progress logs
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("OCR timed out")), OCR_TIMEOUT_MS)
      ),
    ]);
    rawText = result.data.text || "";
    ocrConfidence = result.data.confidence || 0;
  } catch (err) {
    return {
      detectedText: null,
      normalizedCandidate: null,
      isValidFormat: false,
      ocrConfidence: 0,
      error: `OCR failed: ${err.message}`,
    };
  }

  // Look for a plate-shaped token anywhere in the OCR output, line by line and
  // also across concatenated non-whitespace runs (OCR often splits the plate
  // across "words" with spurious spaces).
  const candidates = new Set();
  rawText
    .split(/\r?\n/)
    .map((line) => normalizeCandidate(line))
    .filter(Boolean)
    .forEach((c) => candidates.add(c));
  candidates.add(normalizeCandidate(rawText));

  let matched = null;
  for (const candidate of candidates) {
    const found = candidate.match(PLATE_REGEX);
    if (found) {
      matched = found[0];
      break;
    }
    // also try scanning substrings within a noisy concatenated line
    const substringMatch = candidate.match(/[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}/);
    if (substringMatch) {
      matched = substringMatch[0];
      break;
    }
  }

  return {
    detectedText: rawText.trim().slice(0, 200) || null,
    normalizedCandidate: matched,
    isValidFormat: Boolean(matched),
    ocrConfidence: Number(ocrConfidence.toFixed(2)),
  };
}

module.exports = validateNumberPlate;
