const { allowedOrigins } = require("./config");

function json(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function prepareResponse(request, response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  const origin = String(request.headers.origin || "");
  const sameOrigin = origin && (() => {
    try {
      const parsed = new URL(origin);
      return parsed.host === request.headers.host &&
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === 'localhost'));
    } catch (_) { return false; }
  })();
  if (origin && !sameOrigin && !allowedOrigins().includes(origin)) {
    json(response, 403, { success: false, status: "error", code: "ORIGIN_NOT_ALLOWED",
      message: "This application origin is not allowed." });
    return false;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return false;
  }
  return true;
}

module.exports = { json, prepareResponse };
