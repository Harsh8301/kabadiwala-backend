# Kabadiwala Connect detection backend

Deploy this repository alone to Vercel. The Flutter APK is built separately and
uses the backend's HTTPS origin. Vercel Functions in `api/` handle `/health` and
`/predict`. The marketplace function handles authenticated workflow requests,
and `public/admin.html` is the administrator web panel.

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
| `DATABASE_URL` | PostgreSQL connection string with TLS for marketplace data |

Optional: `ROBOFLOW_CONFIDENCE_THRESHOLD` (default `0.45`),
`ROBOFLOW_OVERLAP_THRESHOLD` (default `0.30`).

Never put `ROBOFLOW_API_KEY` in Flutter, a Dart define, Git, or a Vercel build
argument. `.env` is ignored by Git; `.env.example` lists variable names only.
Production reads Vercel Environment Variables via `process.env`.

## Marketplace database and administrator

Provision a PostgreSQL database for the backend Vercel project. Apply the
schema before using the app:

```powershell
$env:DATABASE_URL = '<database URL>'
$env:ADMIN_EMAIL = '<administrator email>'
$env:ADMIN_PASSWORD = '<unique password of at least 12 characters>'
npm ci
npm run setup:db
```

Remove the temporary admin credentials from the shell after setup. Keep
`DATABASE_URL` in the backend deployment environment. The setup command is
idempotent on a fresh database; changes to an existing schema require a
reviewed migration. Public registration cannot create an admin account.
Open `/admin.html` on the backend origin and sign in with the admin account.

All marketplace calls use `/marketplace?resource=...` with a bearer session
token returned by `POST resource=auth&action=login`. Registration requires an
email and a password of at least 12 characters. Public roles are COLLECTOR,
AGGREGATOR, MIDDLEMAN, and RECYCLER. Recycler offers and recycling actions
require admin verification.

Resources: `me`, `buyers`, `lots`, `batches`, `offers`, `handovers`, `payments`,
`disputes`, `recycling`, `traceability`, `inventory`, `ledger`, `price-board`,
`catalog`, `admin`, and `export`. The bearer account determines owner, buyer,
seller, and actor IDs. The admin web panel uses the same API. Dataset JSON and
CSV downloads come from admin-only, curated export queries. They omit
password hashes, sessions, and secrets.

The sale sequence is offer acceptance, seller handover submission, buyer
measurement, seller final acceptance or dispute, then a payable record and
ownership transfer. A dispute resolution returns the handover to the seller
for final acceptance. Consolidated batches retain source lot IDs and the
append-only trace events of every source lot.

`npm test` includes a real PostgreSQL engine in memory to exercise separate
collector, aggregator, middleman, recycler, and admin accounts. Production
cross-device operation still requires a deployed database and two installed
clients. Payment status is recorded by the buyer; no payment gateway verifies
settlement. Recycling certificates are operational records and make no legal
EPR compliance claim.

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
