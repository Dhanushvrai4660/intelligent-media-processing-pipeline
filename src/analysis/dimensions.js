const sharp = require("sharp");

/**
 * Basic dimension/resolution sanity check.
 * Rejects images too small to be useful for downstream review (e.g. a thumbnail
 * accidentally uploaded instead of the full photo) and flags extreme aspect ratios
 * that suggest a cropped or corrupted capture.
 */
async function validateDimensions(buffer) {
  const minWidth = Number(process.env.MIN_IMAGE_WIDTH) || 400;
  const minHeight = Number(process.env.MIN_IMAGE_HEIGHT) || 300;

  const metadata = await sharp(buffer).metadata();
  const { width, height, format } = metadata;

  const reasons = [];
  if (!width || !height) {
    reasons.push("Could not determine image dimensions");
  } else {
    if (width < minWidth || height < minHeight) {
      reasons.push(`Resolution ${width}x${height} is below minimum ${minWidth}x${minHeight}`);
    }
    const aspectRatio = width / height;
    if (aspectRatio > 4 || aspectRatio < 0.25) {
      reasons.push(`Unusual aspect ratio (${aspectRatio.toFixed(2)}), possible bad crop`);
    }
  }

  return {
    width: width || null,
    height: height || null,
    format: format || null,
    aspectRatio: width && height ? Number((width / height).toFixed(2)) : null,
    isValid: reasons.length === 0,
    reasons,
  };
}

module.exports = validateDimensions;
