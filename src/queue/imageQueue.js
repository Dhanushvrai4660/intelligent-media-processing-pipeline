const { Queue } = require("bullmq");
const createRedisConnection = require("../config/redis");

const QUEUE_NAME = "image-analysis";

const connection = createRedisConnection();

const imageQueue = new Queue(QUEUE_NAME, { connection });

async function enqueueImageAnalysis(imageId) {
  const maxAttempts = Number(process.env.QUEUE_MAX_ATTEMPTS) || 3;

  return imageQueue.add(
    "analyze",
    { imageId },
    {
      attempts: maxAttempts,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    }
  );
}

module.exports = { imageQueue, enqueueImageAnalysis, QUEUE_NAME };
