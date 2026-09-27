const { detectionHandler } = require("../lib/detection-handler");

module.exports = detectionHandler;
module.exports.config = { api: { bodyParser: false } };
