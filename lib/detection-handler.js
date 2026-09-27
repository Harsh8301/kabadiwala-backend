const { getRoboflowConfig } = require("./config");
const { json, prepareResponse } = require("./http");
const { parseImageUpload } = require("./multipart");
const { normalizeRoboflowResponse } = require("./roboflow");
const REQUEST_TIMEOUT_MS = 15000;

function uploadError(response, error) {
  const messages = { FILE_TOO_LARGE: "Choose an image smaller than 4 MB.",
    INVALID_FILE_TYPE: "Choose a JPEG, PNG, or WebP image.",
    MISSING_IMAGE: "Attach one image using the image field.",
    INVALID_MULTIPART: "Send the image as multipart/form-data." };
  return json(response, error.code === "FILE_TOO_LARGE" ? 413 : 400,
    { success: false, status: "error", code: error.code || "INVALID_UPLOAD",
      message: messages[error.code] || "The image upload could not be read." });
}

function upstreamError(response, status) {
  if (status === 400) return json(response, 502, { success: false, status: "error", code: "INFERENCE_REJECTED", message: "The detection service could not process this image." });
  if (status === 401 || status === 403) return json(response, 503, { success: false, status: "error", code: "INFERENCE_NOT_AUTHORIZED", message: "Scrap detection is temporarily unavailable." });
  if (status === 429) return json(response, 429, { success: false, status: "error", code: "INFERENCE_RATE_LIMITED", message: "Detection is busy. Try again or select the material manually." });
  return json(response, 502, { success: false, status: "error", code: "INFERENCE_UNAVAILABLE", message: "Scrap detection is temporarily unavailable." });
}

async function detectionHandler(request, response, dependencies = {}) {
  if (!prepareResponse(request, response)) return;
  if (request.method !== "POST") { response.setHeader("Allow", "POST, OPTIONS");
    return json(response, 405, { success: false, status: "error", code: "METHOD_NOT_ALLOWED", message: "Use POST to analyze a scrap image." }); }
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
    return json(response, 415, { success: false, status: "error", code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the image as multipart/form-data." });
  }
  const config = getRoboflowConfig();
  if (!config.configured) return json(response, 503, { success: false, status: "error", code: "INFERENCE_NOT_CONFIGURED", message: "Scrap detection is temporarily unavailable." });

  let image;
  try { image = await (dependencies.parseImageUpload || parseImageUpload)(request); }
  catch (error) { return uploadError(response, error); }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoint = `https://serverless.roboflow.com/${encodeURIComponent(config.projectId)}/${encodeURIComponent(config.modelVersion)}?confidence=${encodeURIComponent(config.confidence)}&overlap=${encodeURIComponent(config.overlap)}`;
  try {
    const form = new FormData();
    const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
    form.append("file", new Blob([image.buffer], { type: image.mimeType }), `scrap.${extension}`);
    const upstream = await (dependencies.fetch || fetch)(endpoint, { method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form, signal: controller.signal });
    if (!upstream.ok) return upstreamError(response, upstream.status);
    let data;
    try { data = await upstream.json(); }
    catch (_) { return json(response, 502, { success: false, status: "error", code: "INVALID_INFERENCE_RESPONSE", message: "Scrap detection is temporarily unavailable." }); }
    if (!Array.isArray(data?.predictions)) {
      return json(response, 502, { success: false, status: "error", code: "INVALID_INFERENCE_RESPONSE", message: "Scrap detection is temporarily unavailable." });
    }
    return json(response, 200, normalizeRoboflowResponse(data, config.confidence));
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return json(response, timedOut ? 504 : 502, { success: false, status: "error",
      code: timedOut ? "INFERENCE_TIMEOUT" : "INFERENCE_UNAVAILABLE",
      message: "Scrap detection is temporarily unavailable." });
  } finally { clearTimeout(timeout); }
}

module.exports = { detectionHandler, upstreamError, uploadError };
