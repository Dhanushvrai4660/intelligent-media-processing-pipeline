const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const imagesRouter = require("./routes/images");
const analyticsRouter = require("./routes/analytics");
const logger = require("./utils/logger");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Basic abuse protection on the upload endpoint specifically -- generous elsewhere,
// since read endpoints (status/results polling) are expected to be hit frequently
// by clients waiting on an async job.
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many uploads, please slow down." },
});
app.use("/api/images", (req, res, next) => {
  if (req.method === "POST") return uploadLimiter(req, res, next);
  next();
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/images", imagesRouter);
app.use("/api/analytics", analyticsRouter);

// Dashboard: a static, dependency-free HTML/CSS/JS UI that talks to the JSON API above.
// Bonus-scope (the brief lists "dashboard/UI" as optional), so kept intentionally simple:
// no build step, no framework, served directly by the same Express app that serves the
// API -- one deployed service, one URL, nothing extra to host or configure.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Centralized error handler -- anything an async route handler throws (we don't wrap
// every controller in try/catch individually; Express 5-style async errors aren't
// auto-caught in Express 4, so this is a deliberate safety net for anything that slips
// through, alongside the explicit try/catch in uploadImage for the common failure path).
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.stack || err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
