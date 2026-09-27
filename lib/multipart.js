const Busboy = require("busboy");

// Keep the file below Vercel's 4.5 MB total request-body limit. Multipart
// boundaries and headers consume part of that allowance.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function detectedMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

function parseImageUpload(request) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: request.headers,
        limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4, parts: 5 } });
    } catch (_) {
      reject(Object.assign(new Error("multipart/form-data is required"), { code: "INVALID_MULTIPART" }));
      return;
    }
    let image = null;
    let invalidField = false;
    let tooLarge = false;
    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "image") { invalidField = true; stream.resume(); return; }
      const chunks = [];
      stream.on("limit", () => { tooLarge = true; });
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { image = { buffer: Buffer.concat(chunks), claimedMimeType: String(info.mimeType || "").toLowerCase() }; });
    });
    parser.on("error", error => reject(Object.assign(error, { code: "INVALID_MULTIPART" })));
    parser.on("finish", () => {
      if (tooLarge) return reject(Object.assign(new Error("Image exceeds 4 MB"), { code: "FILE_TOO_LARGE" }));
      if (!image || image.buffer.length === 0) return reject(Object.assign(new Error(invalidField ? "Use the image field" : "Image is required"), { code: "MISSING_IMAGE" }));
      const actualMimeType = detectedMimeType(image.buffer);
      if (!ALLOWED_MIME_TYPES.has(image.claimedMimeType) || actualMimeType !== image.claimedMimeType) {
        return reject(Object.assign(new Error("Unsupported image type"), { code: "INVALID_FILE_TYPE" }));
      }
      resolve({ buffer: image.buffer, mimeType: actualMimeType });
    });
    request.pipe(parser);
  });
}

module.exports = { ALLOWED_MIME_TYPES, MAX_IMAGE_BYTES, detectedMimeType, parseImageUpload };
