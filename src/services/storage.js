const cloudinary = require("cloudinary").v2;

/**
 * Cloud storage service (Cloudinary), replacing local disk storage.
 *
 * Why: the API and worker run as separate deployed containers (e.g. two Railway
 * services), which do NOT share a filesystem. An image saved to local disk by the API
 * process would be invisible to the worker process trying to read it back -- this was
 * caught during deployment, not assumed upfront, and is exactly the kind of thing that
 * works fine in a single local `docker compose up` but breaks the moment API and worker
 * become genuinely separate machines. Cloudinary's free tier gives durable, globally
 * reachable storage with zero infra to manage, at the cost of one more external
 * dependency and one more thing that can fail (handled with explicit error surfacing
 * below rather than silently).
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Kept as a no-op for backward compatibility with server.js's startup call --
// there is no local directory to ensure anymore.
function ensureUploadDir() {}

function saveFile(id, originalFilename, buffer) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { public_id: id, folder: "media-pipeline", resource_type: "image", overwrite: false },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        resolve({ storedFilename: result.public_id, storagePath: result.secure_url });
      }
    );
    uploadStream.end(buffer);
  });
}

async function readFile(storagePath) {
  const response = await fetch(storagePath);
  if (!response.ok) {
    throw new Error(`Failed to fetch stored image (${response.status}): ${storagePath}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { saveFile, readFile, ensureUploadDir };
