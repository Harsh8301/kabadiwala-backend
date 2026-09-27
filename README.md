# Kabadiwala Connect detection backend

Deploy this repository alone to Vercel. The Flutter APK is built separately and
uses the backend's HTTPS origin. Vercel Functions in `api/` handle `/health` and
`/predict`; no persistent Node server, static output, or Android files are
deployed.

Current production origin: `https://kabadiwala-backend.vercel.app`.

## Vercel project settings

| Setting | Value |
| --- | --- |
| Repository or folder | `kabadiwala-backend` |
| Root Directory | `.` when importing this repository; `kabadiwala-backend` only if importing a parent repository |
| Framework Preset | Other |
| Build Command | Leave blank; Vercel packages the `api/` functions |
| Output Directory | Leave blank |
| Node.js version | 24.x |

Vercel must install the dependencies from `package-lock.json`. Add these
Environment Variables for Production before deploying:

| Name | Value |
| --- | --- |
| `ROBOFLOW_API_KEY` | Private Roboflow API key for the deployed model |
| `ROBOFLOW_MODEL_ID` | Exact `project/version` model ID from Roboflow |

Optional: `ROBOFLOW_CONFIDENCE_THRESHOLD` (default `0.45`),
`ROBOFLOW_OVERLAP_THRESHOLD` (default `0.30`).

Never put `ROBOFLOW_API_KEY` in Flutter, a Dart define, Git, or a Vercel build
argument. `.env` is ignored by Git; `.env.example` lists variable names only.
Production reads Vercel Environment Variables via `process.env`.

## HTTPS API contract

- `GET https://<deployment-domain>/health` returns `200` JSON with
  `status: "ok"` and `roboflowConfigured: true` when both required variables
  are present. This checks configuration, not model accuracy or key validity.
- `POST https://<deployment-domain>/predict` accepts the Flutter app's
  `multipart/form-data` request with exactly one file field named `image`.
  JPEG, PNG, and WebP are accepted up to 4 MiB. Roboflow receives the image
  through a server-side request with a Bearer authorization header.
- A successful inference returns `success`, `status`, `categoryId`,
  `className`, `confidence`, `predictions`, and `image` dimensions. Unknown
  classes and low confidence return `status: "uncertain"`; the app offers
  manual selection. Invalid uploads and Roboflow failures return sanitized
  error codes.

The class map in `lib/roboflow.js` must be checked against the labels of the
actual deployed model. A device such as a phone does not become "mixed
plastics" automatically. Model accuracy requires labeled field images.

## Checks before deployment

```powershell
npm ci
npm run check
```

The separate Flutter repository's `tool/build_production_apk.ps1` requires a
deployed HTTPS origin, confirms `/health`, then embeds that origin in the APK
through `API_BASE_URL`. Test `/predict` with a labeled scrap photo and an
installed APK on a device before calling the release ready.
