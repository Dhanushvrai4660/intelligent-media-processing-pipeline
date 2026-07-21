/**
 * Pure aggregation logic, deliberately separated from the DB query that feeds it.
 * Takes plain objects (or Mongoose docs, which behave like plain objects for these
 * fields) and returns computed stats. Kept dependency-free specifically so it can be
 * unit tested with hand-built fixtures instead of a live MongoDB connection -- the same
 * reasoning as keeping each analysis check in its own pure module (see analysis/index.js).
 */
function computeAnalyticsFromCompleted(completedImages) {
  const total = completedImages.length;

  const issueFrequency = {};
  let duplicateCount = 0;
  let errorCount = 0; // per-check errors (a check threw and was recorded as {error: ...})
  const processingTimesMs = [];

  for (const image of completedImages) {
    const issues = image.issues || [];
    for (const issue of issues) {
      issueFrequency[issue.check] = (issueFrequency[issue.check] || 0) + 1;
    }

    if (image.analysis && image.analysis.duplicate && image.analysis.duplicate.isDuplicate) {
      duplicateCount += 1;
    }

    if (image.analysis) {
      for (const checkResult of Object.values(image.analysis)) {
        if (checkResult && checkResult.error) errorCount += 1;
      }
    }

    if (image.processingStartedAt && image.processedAt) {
      const start = new Date(image.processingStartedAt).getTime();
      const end = new Date(image.processedAt).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        processingTimesMs.push(end - start);
      }
    }
  }

  const avgProcessingTimeMs = processingTimesMs.length
    ? Math.round(processingTimesMs.reduce((a, b) => a + b, 0) / processingTimesMs.length)
    : null;

  const sortedTimes = [...processingTimesMs].sort((a, b) => a - b);
  const p95ProcessingTimeMs = sortedTimes.length
    ? sortedTimes[Math.floor(0.95 * (sortedTimes.length - 1))]
    : null;

  return {
    totalCompleted: total,
    issueFrequency,
    duplicateRate: total ? Number((duplicateCount / total).toFixed(3)) : 0,
    perCheckErrorCount: errorCount,
    processingTime: {
      avgMs: avgProcessingTimeMs,
      p95Ms: p95ProcessingTimeMs,
      minMs: sortedTimes[0] ?? null,
      maxMs: sortedTimes[sortedTimes.length - 1] ?? null,
      sampleSize: processingTimesMs.length,
    },
  };
}

module.exports = { computeAnalyticsFromCompleted };
