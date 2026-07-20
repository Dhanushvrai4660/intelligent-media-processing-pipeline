const sharp = require("sharp");

/**
 * Blur detection via variance of the Laplacian.
 *
 * A sharp, in-focus image has strong edges -> high-frequency content -> high variance
 * after a Laplacian (2nd derivative) convolution. A blurry image has smooth transitions
 * -> low variance. This is the same classic heuristic used in most OpenCV blur-detection
 * tutorials (cv2.Laplacian(img, CV_64F).var()), reimplemented with sharp's convolution
 * kernel since we intentionally avoided native OpenCV bindings for easier local setup.
 *
 * Threshold is tunable via BLUR_LAPLACIAN_THRESHOLD because "blurry" is inherently a
 * judgment call that depends on the camera/sensor the field images come from -- we are
 * not claiming ground truth accuracy, only a consistent, explainable signal.
 */
async function detectBlur(buffer) {
  const threshold = Number(process.env.BLUR_LAPLACIAN_THRESHOLD) || 100;

  const grayscale = await sharp(buffer).grayscale().toBuffer();

  const { data, info } = await sharp(grayscale)
    .convolve({
      width: 3,
      height: 3,
      kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const diff = data[i] - mean;
    variance += diff * diff;
  }
  variance = variance / n;

  const isBlurry = variance < threshold;

  return {
    laplacianVariance: Number(variance.toFixed(2)),
    threshold,
    isBlurry,
    confidence: isBlurry
      ? Math.min(0.95, 0.5 + (threshold - variance) / threshold / 2)
      : Math.min(0.95, 0.5 + (variance - threshold) / threshold / 2),
    dimensionsChecked: `${info.width}x${info.height}`,
  };
}

module.exports = detectBlur;
