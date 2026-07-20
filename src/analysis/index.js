const detectBlur = require("./blur");
const analyzeBrightness = require("./brightness");
const detectDuplicate = require("./duplicate");
const validateDimensions = require("./dimensions");
const detectScreenshot = require("./screenshot");
const detectTampering = require("./tampering");
const validateNumberPlate = require("./numberPlate");
const logger = require("../utils/logger");

/**
 * Runs every check for one image and returns both the structured per-check results
 * and a flattened `issues` list (used by the results API / any UI to render a simple
 * "here's what's wrong with this image" summary without re-deriving it from the raw
 * per-check objects).
 *
 * Checks run independently and in parallel where they don't depend on each other.
 * A single check throwing does NOT fail the whole job -- it's recorded as a
 * per-check error so one bad heuristic (e.g. OCR timing out) doesn't block every
 * other useful signal. The job as a whole only moves to `failed` if something
 * fundamental breaks (e.g. the file can't be read as an image at all).
 */
async function runAnalysis({ imageId, buffer, fileHash, perceptualHash }) {
  const results = {};
  const issues = [];

  const checks = [
    ["blur", () => detectBlur(buffer)],
    ["brightness", () => analyzeBrightness(buffer)],
    ["dimensions", () => validateDimensions(buffer)],
    ["screenshot", () => detectScreenshot(buffer)],
    ["tampering", () => detectTampering(buffer)],
    ["numberPlate", () => validateNumberPlate(buffer)],
    ["duplicate", () => detectDuplicate({ imageId, fileHash, perceptualHash })],
  ];

  await Promise.all(
    checks.map(async ([name, fn]) => {
      try {
        results[name] = await fn();
      } catch (err) {
        logger.error(`Analysis check "${name}" failed for image ${imageId}: ${err.message}`);
        results[name] = { error: err.message };
      }
    })
  );

  if (results.blur && results.blur.isBlurry) {
    issues.push({ check: "blur", severity: "warning", message: "Image appears blurry" });
  }
  if (results.brightness && results.brightness.isLowLight) {
    issues.push({ check: "brightness", severity: "warning", message: "Image is too dark (low light)" });
  }
  if (results.brightness && results.brightness.isOverexposed) {
    issues.push({ check: "brightness", severity: "warning", message: "Image is overexposed" });
  }
  if (results.dimensions && !results.dimensions.isValid) {
    issues.push({
      check: "dimensions",
      severity: "warning",
      message: results.dimensions.reasons.join("; "),
    });
  }
  if (results.screenshot && results.screenshot.isLikelyScreenshot) {
    issues.push({
      check: "screenshot",
      severity: "critical",
      message: "Image looks like a screenshot or photo-of-a-photo, not an original camera capture",
    });
  }
  if (results.tampering && results.tampering.isSuspicious) {
    issues.push({
      check: "tampering",
      severity: "critical",
      message: "Image metadata suggests possible editing/tampering",
    });
  }
  if (results.numberPlate && !results.numberPlate.isValidFormat) {
    issues.push({
      check: "numberPlate",
      severity: "info",
      message: "Could not detect a valid Indian vehicle number plate in the image",
    });
  }
  if (results.duplicate && results.duplicate.isDuplicate) {
    issues.push({
      check: "duplicate",
      severity: "critical",
      message: `Duplicate of a previously uploaded image (${results.duplicate.matchType}, image ${results.duplicate.matchedImageId})`,
    });
  }

  return { results, issues };
}

module.exports = runAnalysis;
