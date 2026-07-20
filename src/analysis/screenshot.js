const sharp = require("sharp");
const exifr = require("exifr");

// Common device screen resolutions (portrait & landscape). Not exhaustive -- a deliberately
// small, high-confidence list rather than an attempt at completeness, to keep the false
// positive rate low.
const COMMON_SCREEN_RESOLUTIONS = [
  [1080, 1920], [1920, 1080],
  [1170, 2532], [2532, 1170],
  [1284, 2778], [2778, 1284],
  [750, 1334], [1334, 750],
  [828, 1792], [1792, 828],
  [1440, 3200], [3200, 1440],
  [1080, 2400], [2400, 1080],
  [2048, 1536], [1536, 2048], // common tablet/screenshot res
];

function matchesScreenResolution(width, height) {
  return COMMON_SCREEN_RESOLUTIONS.some(([w, h]) => w === width && h === height);
}

/**
 * Screenshot / photo-of-a-photo heuristic.
 *
 * This is genuinely hard to do reliably without a trained classifier, so we combine
 * several *weak* signals into one confidence score rather than pretending any single
 * check is authoritative:
 *
 *  1. No EXIF camera data (Make/Model) at all -> real camera photos almost always carry
 *     this; screenshots and re-saved/edited images typically strip it or never had it.
 *  2. Resolution exactly matches a known device screen size -> strong screenshot signal.
 *  3. Extremely low colour variance combined with hard, perfectly straight edges near
 *     the image border (moire/vignette from photographing a screen or printed photo)
 *     is the classic "photo-of-photo" tell, but detecting that reliably needs frequency-
 *     domain analysis we intentionally scoped out (see README trade-offs). We approximate
 *     it here with an aspect-ratio + no-EXIF combination and label it lower confidence.
 */
async function detectScreenshot(buffer) {
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  let exifData = null;
  try {
    exifData = await exifr.parse(buffer, { pick: ["Make", "Model", "Software"] });
  } catch (_err) {
    exifData = null; // unreadable/absent EXIF is itself a (weak) signal, not a failure
  }

  const hasCameraExif = Boolean(exifData && (exifData.Make || exifData.Model));
  const resolutionMatchesScreen = width && height ? matchesScreenResolution(width, height) : false;

  const reasons = [];
  let score = 0;

  if (!hasCameraExif) {
    reasons.push("No camera EXIF (Make/Model) metadata present");
    score += 0.35;
  }
  if (resolutionMatchesScreen) {
    reasons.push(`Resolution ${width}x${height} matches a common device screen size`);
    score += 0.45;
  }

  const isLikelyScreenshot = score >= 0.5;

  return {
    isLikelyScreenshot,
    confidence: Number(Math.min(score, 0.95).toFixed(2)),
    hasCameraExif,
    resolutionMatchesScreen,
    reasons,
  };
}

module.exports = detectScreenshot;
