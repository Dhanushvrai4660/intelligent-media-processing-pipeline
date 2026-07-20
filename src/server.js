require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { ensureUploadDir } = require("./services/storage");
const logger = require("./utils/logger");

const PORT = process.env.PORT || 3000;

async function start() {
  ensureUploadDir();
  await connectDB();

  const server = app.listen(PORT, () => {
    logger.info(`API server listening on port ${PORT}`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error(`Server failed to start: ${err.message}`);
  process.exit(1);
});
