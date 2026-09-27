function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function getRoboflowConfig() {
  const configuredModelId = String(process.env.ROBOFLOW_MODEL_ID || "").trim();
  const separator = configuredModelId.lastIndexOf("/");
  const modelIdProject = separator > 0 ? configuredModelId.slice(0, separator) : "";
  const modelIdVersion = separator > 0 ? configuredModelId.slice(separator + 1) : "";
  const config = {
    apiKey: String(process.env.ROBOFLOW_API_KEY || "").trim(),
    projectId: modelIdProject || String(process.env.ROBOFLOW_PROJECT_ID || "").trim(),
    modelVersion: modelIdVersion || String(process.env.ROBOFLOW_MODEL_VERSION || "").trim(),
    confidence: numberFromEnv("ROBOFLOW_CONFIDENCE_THRESHOLD", 0.45),
    overlap: numberFromEnv("ROBOFLOW_OVERLAP_THRESHOLD", 0.30)
  };
  return { ...config, configured: Boolean(config.apiKey && config.projectId && config.modelVersion) };
}

function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean);
}

module.exports = { allowedOrigins, getRoboflowConfig };
