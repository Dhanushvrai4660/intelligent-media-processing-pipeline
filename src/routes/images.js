const express = require("express");
const multer = require("multer");
const {
  uploadImage,
  getStatus,
  getResults,
  getImage,
  listImages,
} = require("../controllers/imageController");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB) || 15;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// multer errors (file too large, bad mime type) surface via a callback error, not a thrown
// exception, so they must be caught here rather than relying on Express's default error
// middleware ordering -- wrap the single-file parser explicitly.
function uploadSingleImage(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post("/", uploadSingleImage, asyncHandler(uploadImage));
router.get("/", asyncHandler(listImages));
router.get("/:id/status", asyncHandler(getStatus));
router.get("/:id/results", asyncHandler(getResults));
router.get("/:id", asyncHandler(getImage));

module.exports = router;
