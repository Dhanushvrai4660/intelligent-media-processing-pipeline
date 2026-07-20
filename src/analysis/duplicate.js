const Image = require("../models/Image");
const { hammingDistanceHex } = require("../utils/hash");

/**
 * Duplicate detection, two tiers:
 *
 * 1. Exact duplicate: another document with the same SHA256 file hash. Cheap, indexed
 *    lookup, catches literal re-uploads (same bytes, possibly renamed).
 *
 * 2. Near duplicate: perceptual hash (dHash) with Hamming distance below threshold.
 *    Catches re-compressed/re-saved copies of the same photo (e.g. forwarded through
 *    WhatsApp, which re-encodes images) that would NOT match on SHA256.
 *
 * Trade-off: near-duplicate comparison here scans all completed documents' perceptual
 * hashes. That's fine at take-home / early-product scale (thousands of rows, indexed
 * fetch of a single field) but would need an approximate-nearest-neighbour index
 * (e.g. a vector/LSH index) at real scale -- called out in the README trade-offs section.
 */
async function detectDuplicate({ imageId, fileHash, perceptualHash }) {
  const hammingThreshold = Number(process.env.DUPLICATE_HAMMING_DISTANCE_THRESHOLD) || 5;

  const exactMatch = await Image.findOne({
    fileHash,
    _id: { $ne: imageId },
  }).select("_id originalFilename uploadedAt");

  if (exactMatch) {
    return {
      isDuplicate: true,
      matchType: "exact",
      matchedImageId: exactMatch._id,
      matchedFilename: exactMatch.originalFilename,
      hammingDistance: 0,
    };
  }

  const candidates = await Image.find({
    _id: { $ne: imageId },
    perceptualHash: { $ne: null },
  }).select("_id originalFilename perceptualHash");

  let bestMatch = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = hammingDistanceHex(perceptualHash, candidate.perceptualHash);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  if (bestMatch && bestDistance <= hammingThreshold) {
    return {
      isDuplicate: true,
      matchType: "near_duplicate",
      matchedImageId: bestMatch._id,
      matchedFilename: bestMatch.originalFilename,
      hammingDistance: bestDistance,
    };
  }

  return {
    isDuplicate: false,
    matchType: null,
    matchedImageId: null,
    matchedFilename: null,
    hammingDistance: bestMatch ? bestDistance : null,
  };
}

module.exports = detectDuplicate;
