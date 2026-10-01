-- PTP VSR — remove INCOMPLETE records created on or before 28 Sep 2026 (Malaysia time)
-- Run in Supabase → SQL Editor. Run STEP 1 first and check the list, then run STEP 2.
--
-- "Incomplete" = no actual departure saved yet (actual_last_lift_time is empty),
-- i.e. records still sitting at the Arrival or Prediction stage.
-- Cut-off: created before 29 Sep 2026 00:00 Malaysia time (UTC+8), which means up to the end of 28 Sep.
-- Completed records are never touched.


-- ── STEP 1: PREVIEW — what will be removed ─────────────────────────────
select id,
       vessel_name,
       vessel_reference,
       (created_at at time zone 'Asia/Kuala_Lumpur')::timestamp(0) as created_myt,
       case when predicted_last_lift_time is null then 'Arrival' else 'Prediction' end as stage,
       operator_id
from public.vsr_records
where actual_last_lift_time is null
  and created_at < timestamptz '2026-09-29 00:00:00+08'
order by created_at;


-- ── STEP 2: BACKUP + DELETE (all-or-nothing) ───────────────────────────
begin;

-- Keep a copy of the removed rows in case anything needs to be restored
create table if not exists public.vsr_records_removed_backup as
  select r.*, now() as removed_at from public.vsr_records r where false;
alter table public.vsr_records_removed_backup enable row level security;  -- not readable from the app

insert into public.vsr_records_removed_backup
  select r.*, now() from public.vsr_records r
  where r.actual_last_lift_time is null
    and r.created_at < timestamptz '2026-09-29 00:00:00+08';

delete from public.vsr_records
where actual_last_lift_time is null
  and created_at < timestamptz '2026-09-29 00:00:00+08';

commit;


-- ── STEP 3: CHECK — should return 0 ────────────────────────────────────
select count(*) as remaining_incomplete_to_28_sep
from public.vsr_records
where actual_last_lift_time is null
  and created_at < timestamptz '2026-09-29 00:00:00+08';

-- Restore (only if needed):
--   insert into public.vsr_records select <all columns except removed_at> from public.vsr_records_removed_backup;
-- Drop the backup once you're happy:
--   drop table public.vsr_records_removed_backup;
