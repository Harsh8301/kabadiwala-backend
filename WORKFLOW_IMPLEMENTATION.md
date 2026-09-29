# Kabadiwala Connect workflow implementation audit

## Existing architecture found

The Flutter project already contained collector capture and review, Roboflow
detection, local lot records, basic aggregator and recycler screens, QR
scanning, six-language resources, and a `SharedPreferences` sync queue. The
default remote was a demo repository. Recycler matching and offers used
seeded recycler records. A dataset button logged generated rows locally. The
Node backend only served `/health` and `/predict`; it had no account, database,
marketplace, or admin APIs. The older Flutter workflow remains available to
injected test controllers. The production app now opens authenticated screens.

## Role → screen → API → database

| Role | Production mobile/web surface | API resources | Tables |
| --- | --- | --- | --- |
| Collector | Account, capture/review, live marketplace, offers, handover, disputes, ledger, QR | `auth`, `me`, `lots`, `image`, `offers`, `handovers`, `disputes`, `ledger`, `traceability` | `users`, `sessions`, `lots`, `lot_images`, `offers`, `handovers`, `disputes`, `payments`, `trace_events` |
| Aggregator | Account, live lots, offers, intake, inventory, consolidation, resale, ledger, QR | `lots`, `offers`, `handovers`, `inventory`, `batches`, `ledger`, `traceability` | `lots`, `offers`, `handovers`, `batches`, `payments`, `trace_events` |
| Middleman | Account, live lots/batches, offers, intake, consolidation, resale, ledger, QR | `lots`, `offers`, `handovers`, `inventory`, `batches`, `ledger`, `traceability` | `lots`, `offers`, `handovers`, `batches`, `payments`, `trace_events` |
| Recycler | Account/profile, offers, receipt/measurement, payments, recycling stages, certificate ID, QR | `me`, `offers`, `handovers`, `payments`, `recycling`, `traceability` | `users`, `offers`, `handovers`, `payments`, `recycling`, `trace_events` |
| Admin | Web panel `/admin.html` | `admin`, `disputes`, `export` | All marketplace tables plus `categories`, `material_catalog`, `price_records`, `ai_feedback`, `dismantling_knowledge`, `audit_logs` |

## Changes by requirement

1. **Roles:** The Flutter `UserRole` model includes Middleman and Admin. The
   backend restricts registration to non-admin roles and checks the current
   database role on every request. Existing lowercase Flutter role names map
   to uppercase backend values without changing stored local profiles.
2. **Middleman:** Can receive collector or aggregator stock, build compatible
   batches with source lot IDs, resell to aggregator or verified recycler, and
   view separate purchase, sale, payable, receivable, inventory, and margin
   figures.
3. **Admin web:** Provides dashboard, users, roles, recycler verification,
   categories, materials, price records, lots, batches, offers, transactions,
   handovers, payments, disputes, traceability, recycling, AI feedback,
   dismantling knowledge, audit logs, and dataset exports.
4. **Remote data:** The demo remote repository has been removed. Production
   Flutter uses an authenticated API. SharedPreferences stores session and
   pending local collector lots; the PostgreSQL backend owns shared records.
5. **Offers:** Buyer ID and role come from the authenticated session. Offers
   include rate, unit, expected weight, amount, validity, pickup and payment
   terms, notes, and status. Seller, buyer, record availability, role route,
   and recycler verification are enforced by the backend. Counter and expiry
   states are supported.
6. **Handover and disputes:** Seller submits, buyer measures and can change
   final rate, then seller accepts or disputes. Ownership and a payable record
   are created only after seller acceptance. Buyer may respond to a dispute;
   admin may resolve it; seller then accepts the resolved amount. Sellers may
   also dispute a completed sale's payment without replaying ownership transfer.
7. **Ledger:** Finalized sale revenue and purchase cost are separate. Gross
   margin equals sales revenue minus purchase cost. Cash received, pending
   receivables/payables, and inventory cost are separate fields.
8. **Datasets:** Material, price, buyer, transfer, transaction, traceability,
   feedback, recycler, and recycling records derive from actions in the
   database. Admin-only export returns curated fields; the web UI downloads
   JSON or CSV. Password hashes, tokens, and API keys are excluded.
9. **Traceability and QR:** Transfer and consolidation events append to
   `trace_events`. A batch retains source lot IDs. QR content is only a
   `lot:<uuid>` or `batch:<uuid>` reference; backend authorization applies
   when scanned.
10. **Localization:** New mobile account, marketplace, offer, handover,
    dispute, ledger, inventory, recycling, and image controls have English,
    Hindi, Marathi, Kannada, Telugu, and Bengali labels. Existing Roboflow and
    dismantling screens remain in place.

## Schema and files

New backend tables are `users`, `sessions`, `lots`, `lot_images`, `offers`,
`handovers`, `payments`, `disputes`, `batches`, `trace_events`, `recycling`,
`categories`, `material_catalog`, `price_records`, `ai_feedback`,
`dismantling_knowledge`, and `audit_logs`. `schema.sql` and
`scripts/setup.js` initialize them. `api/marketplace.js` and
`lib/marketplace.js` implement authenticated APIs. `public/admin.html` is the
web panel. The Flutter additions are `services/marketplace_api.dart` and
`screens/live_marketplace.dart`; the app shell, controller, repository,
localization, and QR scanner were updated. Roboflow backend files were not
changed.

## Verification

- Backend: `npm run check` passes, including Roboflow tests and an embedded
  PostgreSQL integration test. The integration test exercises five roles,
  two collector accounts, cross-account lot visibility, offer ownership,
  collector → aggregator → middleman → recycler, aggregator → recycler,
  consolidation, traceability, image permissions, disputes, ledger margin,
  recycling, and admin export permissions.
- Flutter: `flutter pub get`, `flutter analyze`, and `flutter test` pass.
- The admin web script passes a JavaScript syntax check.

## Remaining limits

- This code has not been deployed or tested on two physical devices. The user
  chose code-only work. A hosted PostgreSQL `DATABASE_URL`, schema setup,
  backend deployment, and installed mobile clients are needed for that check.
- Payment state is recorded by the buyer and is not verified by a payment
  provider. Certificates are operational records, not legal EPR certificates.
- Recycler verification is an admin decision based on entered facility and
  authorization details; there is no external registry lookup.
- Material photos are stored in PostgreSQL with a 2 MiB limit. Larger media
  needs object storage before production scale. Only the first collector photo
  is uploaded for a lot.
- Mobile field testing is still needed for camera capture, QR scanning,
  location permission, poor connectivity, and language layout.
