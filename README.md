# ptp-pilot-booking

PTP Vessel Status Report (VSR) — single-page app (vanilla JS + Kendo UI Core + Supabase), deployed on Vercel.

## Database migrations (Supabase → SQL Editor, run once each, safe to re-run)
1. `migration_add_datetimes.sql` — full date-time columns.
2. `migration_prediction_audit.sql` — edit-prediction audit control: edit flags on `vsr_records`,
   read-only `vsr_audit_log` table, and the trigger that logs every prediction edit (who / when / why / old → new).
   The **Edit prediction** button in Records refuses to save until this has been run.

## UI library
`vendor/kendo-ui-core-lite.min.js` is an unmodified subset of Kendo UI Core 2026.3.812 (Apache 2.0):
Dialog, Window, DropDownList, Notification and their dependencies. The Kendo Default theme CSS
is loaded from jsDelivr and recoloured to the PTP palette in `style.css`.
