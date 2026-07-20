const exifr = require("exifr");

// Known editing tool signatures left in the EXIF "Software" field. Not exhaustive --
// this catches the common, lazy case (unedited export from Photoshop/GIMP/Lightroom
// etc.) and says nothing about a careful edit that stripped/forged EXIF, which is
// explicitly called out as a limitation in the README.
const EDITOR_SIGNATURES = [
  "photoshop", "gimp", "lightroom", "snapseed", "picsart",
  "canva", "affinity photo", "paint.net", "pixlr",
];

/**
 * Suspicious-editing heuristic, EXIF-based only (no pixel-level ELA / noise analysis --
 * scoped out, see README). Two signals:
 *
 *  1. Software tag names a known photo editor.
 *  2. ModifyDate is present but earlier than DateTimeOriginal / CreateDate, which is
 *     physically inconsistent for an untouched camera file (the modify time should be
 *     >= the capture time) and suggests the EXIF block itself was copied/forged.
 *
 * This is intentionally conservative: absence of these signals does NOT mean the image
 * is untampered, only that we found no cheap evidence of tampering. We surface it as a
 * low/medium confidence flag, never a hard rejection.
 */
async function detectTampering(buffer) {
  let exifData = null;
  try {
    exifData = await exifr.parse(buffer, {
      pick: ["Software", "ModifyDate", "DateTimeOriginal", "CreateDate"],
    });
  } catch (_err) {
    exifData = null;
  }

  const reasons = [];
  let suspicious = false;

  const software = (exifData && exifData.Software) || null;
  if (software) {
    const matched = EDITOR_SIGNATURES.find((sig) =>
      software.toLowerCase().includes(sig)
    );
    if (matched) {
      reasons.push(`EXIF Software tag indicates editing tool: "${software}"`);
      suspicious = true;
    }
  }

  if (exifData && exifData.ModifyDate && exifData.DateTimeOriginal) {
    const modify = new Date(exifData.ModifyDate);
    const original = new Date(exifData.DateTimeOriginal);
    if (!isNaN(modify) && !isNaN(original) && modify < original) {
      reasons.push("ModifyDate is earlier than DateTimeOriginal (inconsistent EXIF timeline)");
      suspicious = true;
    }
  }

  return {
    isSuspicious: suspicious,
    confidence: suspicious ? 0.6 : 0.2,
    software,
    reasons,
    note: "EXIF-based heuristic only; a careful forgery that strips/rewrites EXIF will not be caught by this check.",
  };
}

module.exports = detectTampering;
