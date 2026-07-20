require("dotenv").config();
const { Worker } = require("bullmq");
const createRedisConnection = require("../config/redis");
const connectDB = require("../config/db");
const Image = require("../models/Image");
const runAnalysis = require("../analysis");
const { readFile } = require("../services/storage");
const logger = require("../utils/logger");
const { QUEUE_NAME } = require("./imageQueue");

const concurrency = Number(process.env.QUEUE_CONCURRENCY) || 2;

async function processJob(job) {
  const { imageId } = job.data;
  const image = await Image.findById(imageId);

  if (!image) {
    // Nothing to update in DB, but this is not a transient error -- don't let BullMQ retry it.
    throw new Error(`Image ${imageId} not found (unrecoverable, will not retry)`);
  }

  image.status = "processing";
  image.processingStartedAt = new Date();
  image.attempts += 1;
  await image.save();

  logger.info(`Processing image ${imageId} (attempt ${image.attempts})`);

  const buffer = readFile(image.storagePath);

  const { results, issues } = await runAnalysis({
    imageId: image._id,
    buffer,
    fileHash: image.fileHash,
    perceptualHash: image.perceptualHash,
  });

  image.analysis = results;
  image.issues = issues;
  image.status = "completed";
  image.processedAt = new Date();
  image.failureReason = null;
  await image.save();

  logger.info(`Completed image ${imageId}: ${issues.length} issue(s) found`);
  return { issuesFound: issues.length };
}

async function start() {
  await connectDB();
  const connection = createRedisConnection();

  // Defensive net: tesseract.js's worker-thread transport can throw an error that
  // bypasses the normal promise chain entirely (observed during testing: a language-data
  // download failure surfaced as an uncaughtException instead of a rejected promise, even
  // though numberPlate.js already wraps Tesseract.recognize in try/catch). Without this
  // handler, that single check would crash the entire worker process and take down every
  // in-flight job with it. We log and keep the process alive; the individual job that
  // triggered it will still fail cleanly and retry via BullMQ's own attempt/backoff logic.
  process.on("uncaughtException", (err) => {
    logger.error(`uncaughtException in worker process (kept alive): ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    logger.error(`unhandledRejection in worker process (kept alive): ${err && err.message}`);
  });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection, concurrency }
  );

  worker.on("completed", (job) => {
    logger.info(`Job ${job.id} completed for image ${job.data.imageId}`);
  });

  worker.on("failed", async (job, err) => {
    logger.error(`Job ${job.id} failed for image ${job.data.imageId}: ${err.message}`);

    // Only mark the DB row as permanently "failed" once BullMQ has exhausted retries --
    // intermediate attempt failures should stay invisible to API consumers, who would
    // otherwise see status flap between processing/failed/processing.
    if (job.attemptsMade >= job.opts.attempts) {
      try {
        await Image.findByIdAndUpdate(job.data.imageId, {
          status: "failed",
          failureReason: err.message,
        });
      } catch (updateErr) {
        logger.error(`Could not persist failure state for ${job.data.imageId}: ${updateErr.message}`);
      }
    }
  });

  logger.info(`Worker started (queue="${QUEUE_NAME}", concurrency=${concurrency})`);
}

start().catch((err) => {
  logger.error(`Worker failed to start: ${err.message}`);
  process.exit(1);
});
