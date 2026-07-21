const { computeAnalyticsFromCompleted } = require("../src/services/analytics");

function fixture({ issues = [], isDuplicate = false, hasError = false, startMs = 0, durationMs = 1000 }) {
  const start = new Date(startMs);
  const end = new Date(startMs + durationMs);
  return {
    issues,
    analysis: {
      duplicate: { isDuplicate },
      blur: hasError ? { error: "boom" } : { isBlurry: false },
    },
    processingStartedAt: start,
    processedAt: end,
  };
}

describe("computeAnalyticsFromCompleted", () => {
  test("returns zeroed stats for an empty input", () => {
    const result = computeAnalyticsFromCompleted([]);
    expect(result.totalCompleted).toBe(0);
    expect(result.duplicateRate).toBe(0);
    expect(result.processingTime.avgMs).toBeNull();
  });

  test("counts issue frequency across multiple images", () => {
    const images = [
      fixture({ issues: [{ check: "blur" }, { check: "duplicate" }] }),
      fixture({ issues: [{ check: "blur" }] }),
      fixture({ issues: [] }),
    ];
    const result = computeAnalyticsFromCompleted(images);
    expect(result.issueFrequency.blur).toBe(2);
    expect(result.issueFrequency.duplicate).toBe(1);
    expect(result.totalCompleted).toBe(3);
  });

  test("computes duplicate rate correctly", () => {
    const images = [
      fixture({ isDuplicate: true }),
      fixture({ isDuplicate: true }),
      fixture({ isDuplicate: false }),
      fixture({ isDuplicate: false }),
    ];
    const result = computeAnalyticsFromCompleted(images);
    expect(result.duplicateRate).toBe(0.5);
  });

  test("counts per-check errors", () => {
    const images = [fixture({ hasError: true }), fixture({ hasError: false })];
    const result = computeAnalyticsFromCompleted(images);
    expect(result.perCheckErrorCount).toBe(1);
  });

  test("computes average and p95 processing time", () => {
    const images = [
      fixture({ durationMs: 1000 }),
      fixture({ durationMs: 2000 }),
      fixture({ durationMs: 3000 }),
    ];
    const result = computeAnalyticsFromCompleted(images);
    expect(result.processingTime.avgMs).toBe(2000);
    expect(result.processingTime.minMs).toBe(1000);
    expect(result.processingTime.maxMs).toBe(3000);
    expect(result.processingTime.sampleSize).toBe(3);
  });

  test("ignores images with missing timestamps rather than throwing", () => {
    const images = [
      fixture({ durationMs: 1000 }),
      { issues: [], analysis: {}, processingStartedAt: null, processedAt: null },
    ];
    const result = computeAnalyticsFromCompleted(images);
    expect(result.processingTime.sampleSize).toBe(1);
  });
});
