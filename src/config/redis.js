const IORedis = require("ioredis");
const logger = require("../utils/logger");

// BullMQ requires maxRetriesPerRequest: null on the connection it manages.
// Managed free Redis providers (e.g. Upstash) hand you a single rediss:// URL with TLS
// enabled rather than separate host/port/password fields -- support both so the same
// code runs unmodified against local Docker Redis and a hosted free-tier instance.
function createRedisConnection() {
  const commonOptions = { maxRetriesPerRequest: null };

  let connection;
  if (process.env.REDIS_URL) {
    connection = new IORedis(process.env.REDIS_URL, commonOptions);
  } else {
    connection = new IORedis({
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      ...commonOptions,
    });
  }

  connection.on("connect", () => logger.info("Redis connected"));
  connection.on("error", (err) => logger.error(`Redis error: ${err.message}`));

  return connection;
}

module.exports = createRedisConnection;
