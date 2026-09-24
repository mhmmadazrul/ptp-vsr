# PTP Vessel Status Report (VSR)

Zero-cost web app for Port of Tanjung Pelepas to capture and analyse vessel turnaround —
Quick Start, departure prediction / SRT, Quick Sail and Total Idle.

**Live:** https://ptp-vsr.vercel.app

## Stack
| Layer | Tool |
|---|---|
| UI components | **Kendo UI Core 2026.3.812** (Apache-2.0, free) + Kendo Default theme 14.5.0 |
| Charts | Chart.js 4 (Kendo Charts are not part of the free Core edition) |
| Frontend | Vanilla HTML/CSS/JS + jQuery 3.7 — no build step |
| Database | Supabase (PostgreSQL, free tier) |
| Hosting | Vercel (auto-deploy on push) |

## Files
```
index.html                     Page shell + library includes
app.js                         All app logic (views, calculations, Supabase calls)
style.css                      App styles + Kendo theme variable overrides
config.js                      Supabase URL + anon key
vendor/kendo-ui-core/          Kendo UI Core subset bundle (only the widgets used) + licence
scripts/build-kendo.sh         Regenerates the Kendo bundle (only needed when upgrading Kendo)
```

## Kendo widgets used
TextBox, TextArea, TimePicker, NumericTextBox, DropDownList (filterable), Button, ButtonGroup,
Dialog, Notification, ListView, Pager, Loader.

The Kendo bundle is self-hosted in `vendor/` because the npm UMD build of `kendo.ui.core` pulls in
`@progress/kendo-drawing` (commercial licence) for the colour picker. The subset bundle leaves that out,
so the app stays on Apache-2.0 components only.

## Business rules (unchanged)
| Metric | Formula | GOOD if |
|---|---|---|
| Quick Start | First Lift − RTW | ≤ 20 min |
| Quick Sail | Last Line − Actual Last Lift | ≤ 17 min |
| Total Idle | Quick Start + Quick Sail | ≤ 37 min |
| SRT compliance | SRT − 15 ≤ Actual Last Lift ≤ SRT | within window |

Recommended SRT = predicted last lift rounded up to the next 15-minute mark.
Poka-yoke: First Line ≤ RTW ≤ First Lift, and Last Line ≥ Actual Last Lift.
Times are 24-hour HH:mm; a sequence that crosses midnight (e.g. 23:50 → 00:05) is treated as
+15 min, not as an error. A later time that is earlier by less than 12 hours is flagged.

## Database
No schema changes — same `vsr_records` and `qc_database` tables and columns as before.
