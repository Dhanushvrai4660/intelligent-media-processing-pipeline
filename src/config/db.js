const mongoose = require("mongoose");
const logger = require("../utils/logger");

async function connectDB() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/media_pipeline";

  mongoose.connection.on("connected", () => {
    logger.info(`MongoDB connected: ${uri}`);
  });

  mongoose.connection.on("error", (err) => {
    logger.error(`MongoDB connection error: ${err.message}`);
  });

  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  await mongoose.connect(uri, {
    // Mongoose 8 no longer needs useNewUrlParser/useUnifiedTopology, kept minimal on purpose
    serverSelectionTimeoutMS: 8000,
  });

  return mongoose.connection;
}

module.exports = connectDB;
