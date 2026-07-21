const Image = require("../models/Image");
const { computeAnalyticsFromCompleted } = require("../services/analytics");

/**
 * GET /api/analytics
 *
 * Two-part query, deliberately split by cost:
 *  1. Status counts via a Mongo `$group` aggregation -- cheap, indexed on `status`,
 *     scales fine regardless of collection size.
 *  2. Per-check issue frequency / duplicate rate / processing-time stats, computed
 *     over `completed` documents only. This one DOES fetch full documents into app
 *     memory (see computeAnalyticsFromCompleted), which is a real scale limit --
 *     documented in the README rather than hidden. Fine at hundreds/low-thousands of
 *     images; would need a proper Mongo aggregation pipeline (or a periodic materialized
 *     summary written by the worker on each job completion, avoiding a full scan on
 *     every dashboard load) beyond that.
 */
async function getAnalytics(req, res) {
  const statusCountsRaw = await Image.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const byStatus = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of statusCountsRaw) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
  }
  const totalImages = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const completedImages = await Image.find({ status: "completed" }).select(
    "issues analysis processingStartedAt processedAt"
  );

  const completedStats = computeAnalyticsFromCompleted(completedImages);

  return res.json({
    totalImages,
    byStatus,
    ...completedStats,
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { getAnalytics };
