const fs = require("fs");
const path = require("path");

const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || "uploads");

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function saveFile(id, originalFilename, buffer) {
  ensureUploadDir();
  const ext = path.extname(originalFilename) || ".jpg";
  const storedFilename = `${id}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, storedFilename);
  fs.writeFileSync(fullPath, buffer);
  return { storedFilename, storagePath: fullPath };
}

function readFile(storagePath) {
  return fs.readFileSync(storagePath);
}

module.exports = { saveFile, readFile, UPLOAD_DIR, ensureUploadDir };
