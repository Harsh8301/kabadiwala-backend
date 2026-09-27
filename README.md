# Kabadiwala Connect detection API

Minimal Node.js API that accepts a scrap image, calls the configured Roboflow
model, and returns a normalized material suggestion. Uploaded images are kept in
memory and are never written to disk. The Roboflow API key stays on the server.

## API contract

### `GET /health`

Returns `200`:

```json
{
  "status": "ok",
  "service": "kabadiwala-backend",
  "roboflowConfigured": true
}
```

### `POST /predict`

Send `multipart/form-data` with one field named `image`. JPEG, PNG, and WebP
files up to 4 MB are accepted. A successful response is:

```json
{
  "success": true,
  "status": "detected",
  "categoryId": "battery",
  "className": "battery",
  "confidence": 0.94,
  "predictions": [
    {
      "categoryId": "battery",
      "className": "battery",
      "confidence": 0.94,
      "x": 120,
      "y": 180,
      "width": 80,
      "height": 160
    }
  ],
  "image": { "width": 640, "height": 480 }
}
```

Low-confidence or unsupported classes return `200` with `status: "uncertain"`
so the app can offer manual selection. Invalid uploads use `400`, `413`, or
`415`; configuration and upstream failures use sanitized `5xx` responses.

## Local development

Use Node.js 24. Copy `.env.example` to `.env`, fill in the server-side values,
then run:

```powershell
npm ci
npm test
npm run build
npm start
```

The local routes are `http://127.0.0.1:5001/health` and
`http://127.0.0.1:5001/predict`.

## Environment variables

- `ROBOFLOW_API_KEY` (required)
- `ROBOFLOW_MODEL_ID` (required; `project/version`)
- `ROBOFLOW_PROJECT_ID` and `ROBOFLOW_MODEL_VERSION` (supported together as a
  legacy alternative when `ROBOFLOW_MODEL_ID` is absent)
- `ROBOFLOW_CONFIDENCE_THRESHOLD` (optional, default `0.45`)
- `ROBOFLOW_OVERLAP_THRESHOLD` (optional, default `0.30`)
- `ALLOWED_ORIGINS` (comma-separated Flutter Web origins; mobile clients do not
  send an Origin header)
- `PORT` (local server only, default `5001`)

Never commit `.env`. Configure the same Roboflow values in Vercel project
settings for Preview and Production.

## Vercel

Deploy this directory as the Vercel project root. `api/health.js` and
`api/predict.js` are the serverless entry points. `vercel.json` rewrites the
public `/health` and `/predict` paths to those functions and gives inference a
30-second maximum duration. No custom build command or persistent server is
required.

Build the Flutter app with the deployed HTTPS origin (without a trailing API
path):

```powershell
flutter build apk --dart-define=API_BASE_URL=https://YOUR_PROJECT.vercel.app
```
