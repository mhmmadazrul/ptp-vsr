-- PTP VSR — add full date-time columns (run once in Supabase → SQL Editor)
-- Existing HH:MM columns stay unchanged; the app writes both.
-- Safe to re-run.

alter table public.vsr_records
  add column if not exists first_line_at          timestamptz,
  add column if not exists rtw_at                 timestamptz,
  add column if not exists first_lift_at          timestamptz,
  add column if not exists predicted_last_lift_at timestamptz,
  add column if not exists suggested_srt_at       timestamptz,
  add column if not exists actual_last_lift_at    timestamptz,
  add column if not exists pilot_onboard_at       timestamptz,
  add column if not exists actual_srt_at          timestamptz,
  add column if not exists last_line_at           timestamptz,
  add column if not exists prediction_base_at     timestamptz;   -- time the prediction was calculated

-- Refresh the API schema cache so the app sees the new columns immediately
notify pgrst, 'reload schema';
