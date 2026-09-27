const { json, prepareResponse } = require("../lib/http");

module.exports = async function index(request, response) {
  if (!prepareResponse(request, response)) return;
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    return json(response, 405, {
      success: false,
      status: "error",
      code: "METHOD_NOT_ALLOWED",
      message: "Use GET for API information."
    });
  }
  return json(response, 200, {
    service: "kabadiwala-backend",
    status: "ok",
    endpoints: { health: "GET /health", predict: "POST /predict" },
    app: "https://kabadiwala-connect-two.vercel.app/"
  });
};
