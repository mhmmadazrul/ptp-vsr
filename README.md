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
Poka-yoke: First Line ≤ RTW, and Last Line ≥ Actual Last Lift.
**Negative Quick Start = ABNORMAL.** A First Lift before RTW is allowed and saved as a negative value (e.g. −10 min),
but classed `ABNORMAL` (Quick Start, and Total Idle once the call is completed). Abnormal calls are **excluded from the
Quick Start and Total Idle dashboard scores and averages**; the dashboard states how many were excluded. Older rows with
a negative Quick Start are treated as abnormal automatically (`mark_abnormal_quick_start.sql` relabels them in the DB).

**Date-aware times.** Every time field carries a date chip. Dates fill in automatically — the first field is today
(or yesterday if the time is more than an hour ahead), later fields take the date nearest the previous field, so
23:50 → 00:05 rolls to the next day. Tap a chip to choose Yesterday / Today / Tomorrow / any date. All calculations
use the full date-time, and both the HH:mm columns and the `*_at` timestamp columns are saved.
Older records without `*_at` values are placed on the date nearest their neighbouring times.

## Workflow
Each phase ends with **Calculate …** → a confirmation popup showing only the details entered → **Edit** (close and
fix) or **Calculate & save**. Results (Quick Start, predicted last lift / SRT, SRT compliance, Quick Sail, Total Idle)
are hidden while entering data and are shown only after the record is saved. Prediction and Departure have a searchable vessel picker (type part of the name or reference).

## User guide
- **Guided tour (EN / BM):** starts by itself the first time each employee ID signs in, and the **?** button in the
  top bar replays the guide for whichever tab is open. It highlights the real fields on screen (with a small animated
  demo of 4-digit time entry). Steps for things not on screen yet are skipped. To show it to everyone again after a big
  change, bump `TOUR_VERSION` in `app.js`.

## Fast data entry
- Times: type `0830`, `830`, `8:30` or `08.30` — a complete 4-digit / `H:mm` time is accepted and the cursor jumps to
  the next field automatically (numeric keypad on phones, no `:` needed). Enter also moves on.
- Tab goes field → field only (the Now buttons and date chips are tap targets, not tab stops).
- Vessel / QC dropdowns: focus and just start typing to search; Enter opens the list. Picking a crane jumps to CMPH.
- Number boxes select their value on focus, so typing replaces it; Enter moves to the next box.
- Calculate with something missing jumps to the first field that needs attention.
- **Drafts are kept on the device.** Everything typed in Arrival, Prediction (per vessel) and Departure (per vessel)
  is saved to the phone/PC's local storage as you type. Switching tabs, closing the browser or app, the phone killing
  the page, a reload or a lost connection won't lose entries — reopening restores them and returns to the same screen.
  Drafts are kept per employee ID, cleared once that record is saved, dropped if another device has already moved
  the vessel to the next phase, and expire after 7 days. Restored times keep the dates they were typed with.

## Edit saved prediction (audit-controlled)
Records → open a vessel → **Edit prediction**. The new last lift / SRT is recalculated from the original prediction
time (not from now); completed calls also get SRT compliance and LL deviation re-evaluated. A reason is mandatory,
and a before/after table is shown before saving. Edited records show an **Edited ×n** pill and an **Audit trail**.

## Database
- `vsr_records`, `qc_database` — as before.
- `migration_add_datetimes.sql` (run once) — the `*_at` date-time columns. If they are missing the app still saves
  (it drops only the missing column and logs a warning), but dates won't be stored.
- `migration_prediction_audit.sql` (run once in Supabase → SQL Editor) — adds edit-tracking columns, the read-only
  `vsr_audit_log` table, and a trigger that refuses an edit without a reason + editor ID and logs old → new values
  in the same transaction. **Edit prediction will not save until this has been run.**
- `mark_abnormal_quick_start.sql` — one-off: relabel existing negative Quick Starts as ABNORMAL.
- `remove_entries_by_011955.sql` — one-off: backs up and removes every record whose arrival was entered by 011955.
- `cleanup_incomplete_until_2026-09-28.sql` — one-off: backs up and removes incomplete records created up to 28 Sep 2026.
