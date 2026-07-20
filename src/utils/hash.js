const crypto = require("crypto");
const sharp = require("sharp");

/**
 * Exact-duplicate detection: SHA256 over raw file bytes.
 * Cheap, deterministic, catches re-uploads of the same file (even renamed).
 */
function sha256File(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Near-duplicate detection: difference hash (dHash).
 * Resize to 9x8 grayscale, compare each pixel to its right neighbour -> 64 bit signature.
 * Similar images (recompressed, slightly cropped, re-uploaded via WhatsApp, etc.)
 * produce hashes with a small Hamming distance, even though SHA256 differs completely.
 */
async function computeDHash(buffer) {
  const { data } = await sharp(buffer)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits += left < right ? "1" : "0";
    }
  }

  // Store as hex for compactness
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

function hammingDistanceHex(hexA, hexB) {
  const a = BigInt("0x" + hexA);
  const b = BigInt("0x" + hexB);
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

module.exports = { sha256File, computeDHash, hammingDistanceHex };
