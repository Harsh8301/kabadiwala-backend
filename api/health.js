const { getRoboflowConfig } = require("../lib/config");
const { json, prepareResponse } = require("../lib/http");
module.exports = async function health(request, response) {
  if (!prepareResponse(request, response)) return;
  if (request.method !== "GET") { response.setHeader("Allow", "GET, OPTIONS");
    return json(response, 405, { success: false, status: "error", code: "METHOD_NOT_ALLOWED", message: "Use GET for service health." }); }
  return json(response, 200, {
    status: "ok",
    service: "kabadiwala-backend",
    roboflowConfigured: getRoboflowConfig().configured
  });
};
