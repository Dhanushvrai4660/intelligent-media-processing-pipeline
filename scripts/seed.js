/**
 * Generates a handful of synthetic sample images (sharp, in-memory) exercising the
 * different heuristics -- one sharp/normal image, one blurry, one very dark, one that
 * looks like a screenshot resolution -- and uploads them through the real HTTP API so
 * you get a populated, demoable dataset without needing a real phone/camera photo set.
 *
 * Usage: npm run seed   (requires the API server to already be running on API_BASE_URL)
 */
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const os = require("os");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";

async function makeImage({ width, height, color, blur }) {
  let img = sharp({ create: { width, height, channels: 3, background: color } });
  if (blur) img = img.blur(20);
  return img.jpeg().toBuffer();
}

async function upload(filename, buffer) {
  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, buffer);

  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/jpeg" }), filename);

  const res = await fetch(`${API_BASE_URL}/api/images`, { method: "POST", body: form });
  const body = await res.json();
  fs.unlinkSync(tmpPath);
  console.log(`Uploaded ${filename} ->`, body);
  return body;
}

async function main() {
  console.log(`Seeding sample images against ${API_BASE_URL} ...`);

  const samples = [
    { filename: "normal.jpg", opts: { width: 1200, height: 900, color: { r: 130, g: 140, b: 120 }, blur: false } },
    { filename: "blurry.jpg", opts: { width: 1200, height: 900, color: { r: 130, g: 140, b: 120 }, blur: true } },
    { filename: "low_light.jpg", opts: { width: 1200, height: 900, color: { r: 15, g: 15, b: 20 }, blur: false } },
    { filename: "screenshot_like.jpg", opts: { width: 1080, height: 1920, color: { r: 240, g: 240, b: 240 }, blur: false } },
    { filename: "too_small.jpg", opts: { width: 150, height: 100, color: { r: 100, g: 100, b: 100 }, blur: false } },
  ];

  for (const sample of samples) {
    const buffer = await makeImage(sample.opts);
    await upload(sample.filename, buffer);
  }

  console.log("\nDone. Poll GET /api/images to watch jobs move pending -> processing -> completed.");
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
