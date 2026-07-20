const mongoose = require("mongoose");

const AnalysisIssueSchema = new mongoose.Schema(
  {
    check: { type: String, required: true },
    severity: { type: String, enum: ["info", "warning", "critical"], required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const ImageSchema = new mongoose.Schema(
  {
    // Public-facing processing ID (also used as the Mongo _id, generated at upload time
    // so we can return it to the client immediately, before any processing happens).
    _id: { type: String },

    originalFilename: { type: String, required: true },
    storedFilename: { type: String, required: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },

    fileHash: { type: String, required: true, index: true }, // sha256, exact duplicate
    perceptualHash: { type: String, index: true }, // dHash, near duplicate

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },

    attempts: { type: Number, default: 0 },
    failureReason: { type: String, default: null },

    uploadedAt: { type: Date, default: Date.now },
    processingStartedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },

    analysis: {
      blur: { type: mongoose.Schema.Types.Mixed, default: null },
      brightness: { type: mongoose.Schema.Types.Mixed, default: null },
      duplicate: { type: mongoose.Schema.Types.Mixed, default: null },
      dimensions: { type: mongoose.Schema.Types.Mixed, default: null },
      screenshot: { type: mongoose.Schema.Types.Mixed, default: null },
      tampering: { type: mongoose.Schema.Types.Mixed, default: null },
      numberPlate: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    issues: { type: [AnalysisIssueSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Image", ImageSchema);
