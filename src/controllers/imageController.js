const { v4: uuidv4 } = require("uuid");
const Image = require("../models/Image");
const { saveFile } = require("../services/storage");
const { sha256File, computeDHash } = require("../utils/hash");
const { enqueueImageAnalysis } = require("../queue/imageQueue");
const logger = require("../utils/logger");

async function uploadImage(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided (field name: 'image')" });
  }

  const imageId = uuidv4();
  const { originalname, mimetype, size, buffer } = req.file;

  try {
    const fileHash = sha256File(buffer);

    let perceptualHash = null;
    try {
      perceptualHash = await computeDHash(buffer);
    } catch (err) {
      // A perceptual-hash failure (e.g. unusual/corrupt image) should not block the
      // upload itself -- duplicate detection will just skip the near-duplicate tier
      // for this image later. The upload API's job is to accept the file quickly.
      logger.warn(`Could not compute perceptual hash for upload ${imageId}: ${err.message}`);
    }

    const { storedFilename, storagePath } = saveFile(imageId, originalname, buffer);

    const image = await Image.create({
      _id: imageId,
      originalFilename: originalname,
      storedFilename,
      storagePath,
      mimeType: mimetype,
      sizeBytes: size,
      fileHash,
      perceptualHash,
      status: "pending",
    });

    await enqueueImageAnalysis(imageId);

    return res.status(202).json({
      id: image._id,
      status: image.status,
      uploadedAt: image.uploadedAt,
      message: "Image accepted for processing",
    });
  } catch (err) {
    logger.error(`Upload failed: ${err.message}`);
    return res.status(500).json({ error: "Failed to process upload", details: err.message });
  }
}

async function getStatus(req, res) {
  const image = await Image.findById(req.params.id).select(
    "status uploadedAt processingStartedAt processedAt attempts failureReason"
  );
  if (!image) return res.status(404).json({ error: "Image not found" });

  return res.json({
    id: req.params.id,
    status: image.status,
    uploadedAt: image.uploadedAt,
    processingStartedAt: image.processingStartedAt,
    processedAt: image.processedAt,
    attempts: image.attempts,
    failureReason: image.failureReason,
  });
}

async function getResults(req, res) {
  const image = await Image.findById(req.params.id).select(
    "status analysis issues failureReason originalFilename"
  );
  if (!image) return res.status(404).json({ error: "Image not found" });

  if (image.status !== "completed") {
    return res.status(409).json({
      error: `Analysis not available yet (current status: ${image.status})`,
      status: image.status,
      failureReason: image.failureReason,
    });
  }

  return res.json({
    id: req.params.id,
    originalFilename: image.originalFilename,
    status: image.status,
    issues: image.issues,
    analysis: image.analysis,
  });
}

async function getImage(req, res) {
  const image = await Image.findById(req.params.id);
  if (!image) return res.status(404).json({ error: "Image not found" });
  return res.json(image);
}

async function listImages(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const statusFilter = req.query.status;

  const query = statusFilter ? { status: statusFilter } : {};

  const [items, total] = await Promise.all([
    Image.find(query)
      .select("originalFilename status uploadedAt processedAt issues")
      .sort({ uploadedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Image.countDocuments(query),
  ]);

  return res.json({ page, limit, total, items });
}

module.exports = { uploadImage, getStatus, getResults, getImage, listImages };
