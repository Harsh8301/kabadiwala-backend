const DEFAULT_CONFIDENCE_THRESHOLD = 0.45;
const CLOSE_CONFIDENCE_DELTA = 0.03;

const ROBOFLOW_CLASS_MAP = Object.freeze({
  cable: "cables", cables: "cables", wire: "cables",
  "copper-wire": "cables", "copper-cable": "cables",
  pcb: "pcb", "circuit-board": "pcb", "printed-circuit-board": "pcb",
  battery: "battery", batteries: "battery", "battery-cell": "battery",
  "lithium-battery": "battery", "lead-acid-battery": "battery",
  motor: "motor", "electric-motor": "motor",
  crt: "crt", "crt-monitor": "crt", "crt-display": "crt",
  lcd: "lcd", "lcd-panel": "lcd", "lcd-display": "lcd",
  "flat-display": "lcd", "flat-display-panel": "lcd",
  magnet: "magnets", magnets: "magnets", "magnet-assembly": "magnets",
  "mixed-plastics": "mixed_plastics", "electronic-plastics": "mixed_plastics",
  "plastic-housing": "mixed_plastics"
});

function normalizeLabel(label) {
  return String(label || "").toLowerCase().trim()
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function mapRoboflowClass(label) {
  return ROBOFLOW_CLASS_MAP[normalizeLabel(label)] || "other";
}

function getPredictionClass(prediction) {
  return prediction?.class || prediction?.className || prediction?.label || prediction?.name || "";
}

function getPredictionConfidence(prediction) {
  const value = prediction?.confidence ?? prediction?.score ?? prediction?.probability ?? 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? number / 100 : number;
}

function normalizePrediction(prediction) {
  const className = String(getPredictionClass(prediction));
  return {
    categoryId: mapRoboflowClass(className), className,
    confidence: getPredictionConfidence(prediction),
    x: Number(prediction?.x ?? prediction?.bbox?.x ?? 0) || 0,
    y: Number(prediction?.y ?? prediction?.bbox?.y ?? 0) || 0,
    width: Number(prediction?.width ?? prediction?.w ?? prediction?.bbox?.width ?? 0) || 0,
    height: Number(prediction?.height ?? prediction?.h ?? prediction?.bbox?.height ?? 0) || 0
  };
}

function predictionArea(prediction) {
  return Math.max(0, prediction.width) * Math.max(0, prediction.height);
}

function selectPrimaryPrediction(predictions, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD) {
  const parsed = Number(confidenceThreshold);
  const threshold = Number.isFinite(parsed) ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
  return predictions
    .filter(prediction => prediction.confidence >= threshold && prediction.categoryId !== "other")
    .sort((a, b) => {
      const confidenceDelta = b.confidence - a.confidence;
      if (Math.abs(confidenceDelta) > CLOSE_CONFIDENCE_DELTA) return confidenceDelta;
      return predictionArea(b) - predictionArea(a);
    })[0] || null;
}

function getImageDimensions(raw) {
  return {
    width: Number(raw?.image?.width ?? raw?.image?.dimensions?.width ?? raw?.width ?? 0) || 0,
    height: Number(raw?.image?.height ?? raw?.image?.dimensions?.height ?? raw?.height ?? 0) || 0
  };
}

function normalizeRoboflowResponse(raw, confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD) {
  const parsed = Number(confidenceThreshold);
  const threshold = Number.isFinite(parsed) ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
  const predictions = (Array.isArray(raw?.predictions) ? raw.predictions : [])
    .map(normalizePrediction).filter(prediction => prediction.confidence >= threshold);
  const primary = selectPrimaryPrediction(predictions, threshold);
  const image = getImageDimensions(raw);
  if (!primary) {
    return { success: true, status: "uncertain", categoryId: null, className: null,
      confidence: 0, predictions, image };
  }
  return { success: true, status: primary.confidence >= 0.7 ? "detected" : "possible",
    categoryId: primary.categoryId, className: primary.className,
    confidence: primary.confidence, predictions, image };
}

module.exports = { CLOSE_CONFIDENCE_DELTA, DEFAULT_CONFIDENCE_THRESHOLD,
  ROBOFLOW_CLASS_MAP, mapRoboflowClass, normalizeLabel, normalizePrediction,
  normalizeRoboflowResponse, selectPrimaryPrediction };
