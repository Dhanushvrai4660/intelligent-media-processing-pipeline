const sharp = require("sharp");

/**
 * Brightness analysis via mean pixel luminance on the grayscale channel.
 * sharp's .stats() gives us per-channel mean/stdev cheaply without a manual pixel loop.
 *
 * Two thresholds:
 *  - below LOW_LIGHT threshold -> flagged as low light (common field-photo problem: night,
 *    underground parking, poor warehouse lighting)
 *  - above BRIGHT threshold -> flagged as overexposed/blown out (flash glare on glossy
 *    vehicle paint, direct sun)
 */
async function analyzeBrightness(buffer) {
  const lowThreshold = Number(process.env.LOW_LIGHT_LUMINANCE_THRESHOLD) || 60;
  const highThreshold = Number(process.env.BRIGHT_LUMINANCE_THRESHOLD) || 235;

  const stats = await sharp(buffer).grayscale().stats();
  const meanLuminance = stats.channels[0].mean; // 0-255

  const isLowLight = meanLuminance < lowThreshold;
  const isOverexposed = meanLuminance > highThreshold;

  let level = "normal";
  if (isLowLight) level = "low_light";
  else if (isOverexposed) level = "overexposed";

  return {
    meanLuminance: Number(meanLuminance.toFixed(2)),
    stdDev: Number(stats.channels[0].stdev.toFixed(2)),
    level,
    isLowLight,
    isOverexposed,
    thresholds: { low: lowThreshold, high: highThreshold },
  };
}

module.exports = analyzeBrightness;
