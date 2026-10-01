-- PTP VSR — remove every vessel-call record entered by employee 011955
-- Run in Supabase → SQL Editor. Run STEP 1 first and check the list, then STEP 2.
--
-- "Entered by" = the arrival was recorded by 011955 (operator_id). The whole record is removed,
-- including any prediction / departure other people added to it afterwards.
-- STEP 1 also lists records created by someone else where 011955 only did the prediction or
-- departure — those are NOT deleted (see the note at the bottom).

-- ── STEP 1: PREVIEW ─────────────────────────────────────────────────────
select id,
       vessel_name,
       vessel_reference,
       (created_at at time zone 'Asia/Kuala_Lumpur')::timestamp(0) as created_myt,
       operator_id, prediction_operator, departure_operator,
       case when upper(trim(operator_id)) = '011955' then 'WILL BE DELETED'
            else 'kept — 011955 only did prediction/departure' end as action
from public.vsr_records
where upper(trim(operator_id)) = '011955'
   or upper(trim(coalesce(prediction_operator, ''))) = '011955'
   or upper(trim(coalesce(departure_operator, ''))) = '011955'
order by created_at;


-- ── STEP 2: BACKUP + DELETE (all-or-nothing) ────────────────────────────
begin;

create table if not exists public.vsr_records_removed_backup as
  select r.*, now() as removed_at from public.vsr_records r where false;
alter table public.vsr_records_removed_backup enable row level security;  -- not readable from the app

insert into public.vsr_records_removed_backup
  select r.*, now() from public.vsr_records r
  where upper(trim(r.operator_id)) = '011955';

delete from public.vsr_records
where upper(trim(operator_id)) = '011955';

commit;


-- ── STEP 3: CHECK — should return 0 ─────────────────────────────────────
select count(*) as remaining_by_011955
from public.vsr_records
where upper(trim(operator_id)) = '011955';

-- Note: audit-log entries (vsr_audit_log) for these records are kept on purpose — the audit trail
-- is never deleted. Removed rows are in vsr_records_removed_backup if anything needs restoring.
