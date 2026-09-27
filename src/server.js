
const http = require("node:http");

require("dotenv").config({ quiet: true });

const detectionHandler = require("../api/predict");
const healthHandler = require("../api/health");

function notFound(response) {
  response.statusCode = 404;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({
    success: false,
    status: "error",
    code: "NOT_FOUND",
    message: "API route not found."
  }));
}

function createServer() {
  return http.createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;

    try {
      if (path === "/health" || path === "/api/health") {
        await healthHandler(request, response);
        return;
      }
      if (path === "/predict" || path === "/api/predict") {
        await detectionHandler(request, response);
        return;
      }
      notFound(response);
    } catch (_) {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({
        success: false,
        status: "error",
        code: "INTERNAL_ERROR",
        message: "The service could not complete the request."
      }));
    }
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "5001", 10);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Kabadiwala backend listening on http://0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
