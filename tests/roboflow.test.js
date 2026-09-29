const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { getRoboflowConfig } = require("../lib/config");
const healthHandler = require("../api/health");
const { detectionHandler } = require("../lib/detection-handler");
const { MAX_IMAGE_BYTES, detectedMimeType, parseImageUpload } = require("../lib/multipart");
const { mapRoboflowClass, normalizeLabel, normalizeRoboflowResponse,
  selectPrimaryPrediction } = require("../lib/roboflow");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function responseRecorder() {
  const response = new EventEmitter();
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.end = body => { response.body = body || ""; response.emit("done"); };
  return response;
}

function multipartRequest(content, { fieldName = "image", mimeType = "image/jpeg" } = {}) {
  const boundary = "kabadiwala-test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="test.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const request = Readable.from(body);
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length)
  };
  return request;
}

async function callHandler({ method = "POST", contentType = "multipart/form-data; boundary=x", parse, fetch }) {
  const request = { method, headers: { "content-type": contentType } };
  const response = responseRecorder();
  await detectionHandler(request, response, { parseImageUpload: parse, fetch });
  return { status: response.statusCode, body: JSON.parse(response.body || "{}") };
}

test("normalizes labels", () => {
  assert.equal(normalizeLabel(" Printed Circuit__Board "), "printed-circuit-board");
});

test("Vercel health function reports configuration without exposing secrets", async () => {
  const request = { method: "GET", headers: {} };
  const response = responseRecorder();
  await healthHandler(request, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.roboflowConfigured, "boolean");
  assert.doesNotMatch(response.body, /apiKey|ROBOFLOW_API_KEY/);
});

test("combined model ID takes precedence over legacy model variables", () => {
  Object.assign(process.env, {
    ROBOFLOW_API_KEY: "test-placeholder",
    ROBOFLOW_MODEL_ID: "correct-project/7",
    ROBOFLOW_PROJECT_ID: "stale-project",
    ROBOFLOW_MODEL_VERSION: "1"
  });
  const config = getRoboflowConfig();
  assert.equal(config.projectId, "correct-project");
  assert.equal(config.modelVersion, "7");
  delete process.env.ROBOFLOW_MODEL_ID;
});

test("maps supported classes and unknowns", () => {
  assert.equal(mapRoboflowClass("copper wire"), "cables");
  assert.equal(mapRoboflowClass("battery-cell"), "battery");
  assert.equal(mapRoboflowClass("CRT Monitor"), "crt");
  assert.equal(mapRoboflowClass("lcd panel"), "lcd");
  assert.equal(mapRoboflowClass("magnet assembly"), "magnets");
  assert.equal(mapRoboflowClass("mixed plastics"), "mixed_plastics");
  assert.equal(mapRoboflowClass("phone"), "device_phone");
  assert.equal(mapRoboflowClass("watch"), "device_watch");
  assert.equal(mapRoboflowClass("tablet"), "device_tablet");
  assert.equal(mapRoboflowClass("mouse"), "device_mouse");
  assert.equal(mapRoboflowClass("plastic bottle"), "other");
});

test("uses a Vercel-safe upload limit", () => {
  assert.equal(MAX_IMAGE_BYTES, 4 * 1024 * 1024);
});

test("selects highest reliable supported prediction", () => {
  const result = normalizeRoboflowResponse({ predictions: [
    { class: "plastic bottle", confidence: 0.92, width: 100, height: 100 },
    { class: "battery", confidence: 0.88, width: 10, height: 10 }
  ] });
  assert.equal(result.categoryId, "battery");
  assert.equal(result.status, "detected");
});

test("categorizes whole devices without assigning them a material", () => {
  const result = normalizeRoboflowResponse({ predictions: [
    { class: "tablet", confidence: 0.53 },
    { class: "watch", confidence: 0.15 }
  ] }, 0);
  assert.equal(result.success, true);
  assert.equal(result.status, "possible");
  assert.equal(result.categoryId, "device_tablet");
  assert.equal(result.className, "tablet");
  assert.equal(selectPrimaryPrediction([
    { categoryId: "device_phone", confidence: 0.1 }
  ], 0), null);
});

test("uses area as tie breaker for close confidence", () => {
  const primary = selectPrimaryPrediction([
    { categoryId: "pcb", confidence: 0.81, width: 10, height: 10 },
    { categoryId: "motor", confidence: 0.80, width: 50, height: 50 }
  ]);
  assert.equal(primary.categoryId, "motor");
});

test("empty and low-confidence predictions are uncertain", () => {
  assert.equal(normalizeRoboflowResponse({ predictions: [] }).status, "uncertain");
  const low = normalizeRoboflowResponse({ predictions: [{ class: "pcb", confidence: 0.2 }] });
  assert.equal(low.categoryId, null);
  assert.deepEqual(low.predictions, []);
});

test("image signatures accept JPEG PNG and WebP only", () => {
  assert.equal(detectedMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(detectedMimeType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(detectedMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(detectedMimeType(Buffer.from("not-an-image")), null);
});

test("missing configuration returns a sanitized error", async () => {
  const previous = process.env.ROBOFLOW_API_KEY;
  delete process.env.ROBOFLOW_API_KEY;
  const result = await callHandler({ parse: async () => { throw new Error("should not run"); } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "INFERENCE_NOT_CONFIGURED");
  assert.doesNotMatch(JSON.stringify(result.body), /stack|Bearer/i);
  if (previous === undefined) delete process.env.ROBOFLOW_API_KEY;
  else process.env.ROBOFLOW_API_KEY = previous;
});

test("missing image and invalid type are handled", async () => {
  Object.assign(process.env, { ROBOFLOW_API_KEY: "test-placeholder", ROBOFLOW_PROJECT_ID: "project", ROBOFLOW_MODEL_VERSION: "1" });
  const missing = await callHandler({ parse: async () => { throw Object.assign(new Error(), { code: "MISSING_IMAGE" }); } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "MISSING_IMAGE");
  const invalid = await callHandler({ parse: async () => { throw Object.assign(new Error(), { code: "INVALID_FILE_TYPE" }); } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_FILE_TYPE");
});

test("multipart parser accepts the image field and rejects invalid files", async () => {
  const accepted = await parseImageUpload(multipartRequest(Buffer.from([0xff, 0xd8, 0xff, 0x00])));
  assert.equal(accepted.mimeType, "image/jpeg");

  await assert.rejects(
    parseImageUpload(multipartRequest(Buffer.from("not-an-image"), { mimeType: "image/jpeg" })),
    error => error.code === "INVALID_FILE_TYPE"
  );
  await assert.rejects(
    parseImageUpload(multipartRequest(Buffer.from([0xff, 0xd8, 0xff, 0x00]), { fieldName: "file" })),
    error => error.code === "MISSING_IMAGE"
  );
});

test("multipart parser rejects oversized images", async () => {
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  oversized[2] = 0xff;
  await assert.rejects(
    parseImageUpload(multipartRequest(oversized)),
    error => error.code === "FILE_TOO_LARGE"
  );
});

test("rejects wrong methods and content types", async () => {
  const wrongMethod = await callHandler({ method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, "METHOD_NOT_ALLOWED");
  const wrongType = await callHandler({ contentType: "application/json" });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("normalizes a successful provider response", async () => {
  Object.assign(process.env, { ROBOFLOW_API_KEY: "test-placeholder", ROBOFLOW_PROJECT_ID: "project", ROBOFLOW_MODEL_VERSION: "1" });
  let outbound;
  const result = await callHandler({
    parse: async () => ({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
    fetch: async (url, options) => { outbound = { url, options }; return ({
      ok: true,
      json: async () => ({
        predictions: [{ class: "battery", confidence: 0.91 }],
        image: { width: 640, height: 480 }
      })
    }); }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "detected");
  assert.equal(result.body.categoryId, "battery");
  assert.deepEqual(result.body.image, { width: 640, height: 480 });
  assert.equal(outbound.options.headers.Authorization, "Bearer test-placeholder");
  assert.equal(outbound.options.body.get("file").type, "image/jpeg");
  assert.equal(outbound.options.body.get("file").size, 1);
  assert.match(outbound.url, /^https:\/\/serverless\.roboflow\.com\//);
  assert.doesNotMatch(outbound.url, /test-placeholder/);
});

test("unsupported provider class remains uncertain", () => {
  const result = normalizeRoboflowResponse({ predictions: [{ class: "plastic bottle", confidence: 0.91 }] });
  assert.equal(result.status, "uncertain");
  assert.equal(result.categoryId, null);
});

test("provider rejection and malformed response are sanitized", async () => {
  const parse = async () => ({ buffer: Buffer.from([1]), mimeType: "image/jpeg" });
  const rejected = await callHandler({ parse, fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.code, "INFERENCE_NOT_AUTHORIZED");
  const malformed = await callHandler({ parse, fetch: async () => ({ ok: true, json: async () => ({ error: "bad" }) }) });
  assert.equal(malformed.status, 502);
  assert.equal(malformed.body.code, "INVALID_INFERENCE_RESPONSE");
  const unavailable = await callHandler({ parse, fetch: async () => { throw new Error("provider down"); } });
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.body.code, "INFERENCE_UNAVAILABLE");
});

test("upstream errors never expose secret or stack", async () => {
  Object.assign(process.env, { ROBOFLOW_API_KEY: "private-test-value", ROBOFLOW_PROJECT_ID: "project", ROBOFLOW_MODEL_VERSION: "1" });
  const result = await callHandler({
    parse: async () => ({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
    fetch: async () => ({ ok: false, status: 500 })
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "INFERENCE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result.body), /private-test-value|stack/i);
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`not ok - ${name}`); console.error(error); process.exitCode = 1; }
  }
})();
