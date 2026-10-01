-- PTP VSR — flag existing negative Quick Starts as ABNORMAL (run once; safe to re-run)
-- New records are flagged by the app. This brings older rows in line so CSV exports and any
-- other reports read the same. The dashboard already treats any negative Quick Start as abnormal.

-- Preview
select id, vessel_name, vessel_reference, quick_start_minutes, quick_start_class, total_idle_minutes, total_idle_class
from public.vsr_records
where quick_start_minutes < 0
order by created_at;

-- Update
update public.vsr_records
set quick_start_class = 'ABNORMAL',
    total_idle_class  = case when total_idle_class is not null then 'ABNORMAL' else null end
where quick_start_minutes < 0
  and (quick_start_class is distinct from 'ABNORMAL' or (total_idle_class is not null and total_idle_class <> 'ABNORMAL'));
