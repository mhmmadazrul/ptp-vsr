-- PTP VSR — Prediction edit + audit control (run once in Supabase → SQL Editor)
-- Safe to re-run.
--
-- What this does
--   1. Adds edit-tracking columns to vsr_records (edited flag, count, who/when/why).
--   2. Creates vsr_audit_log — one row per prediction edit with old → new values.
--   3. Adds a BEFORE UPDATE trigger that, whenever an already-saved prediction is changed:
--        • refuses the change unless that update supplies a reason and editor ID
--          (edit_reason_input / edit_by_input — cleared after use, so they can't be reused),
--        • marks the record as edited and bumps the edit counter,
--        • writes the field-by-field diff to vsr_audit_log in the same transaction.
--      The app cannot set the edited flag / counter itself, and the audit table is
--      read-only to the app (no insert/update/delete from the anon key).

-- 1 ── Edit-tracking columns ─────────────────────────────────────────────
alter table public.vsr_records
  add column if not exists prediction_base_at        timestamptz,          -- time the prediction was calculated
  add column if not exists prediction_edited         boolean not null default false,
  add column if not exists prediction_edit_count     integer not null default 0,
  add column if not exists prediction_edit_reason    text,                 -- reason given for the latest edit
  add column if not exists prediction_last_edited_by text,
  add column if not exists prediction_last_edited_at timestamptz,
  -- Write-only inputs for an edit: the app sends these with every edit, the trigger
  -- consumes them and clears them, so each edit must carry its own reason + editor.
  add column if not exists edit_reason_input         text,
  add column if not exists edit_by_input             text;

-- 2 ── Audit log table ───────────────────────────────────────────────────
create table if not exists public.vsr_audit_log (
  id          bigint generated always as identity primary key,
  record_id   text        not null,
  vessel_name text,
  action      text        not null default 'prediction_edit',
  changes     jsonb       not null,          -- { field: { "old": …, "new": … }, … }
  reason      text        not null,
  edited_by   text        not null,
  edited_at   timestamptz not null default now()
);
create index if not exists vsr_audit_log_record_idx on public.vsr_audit_log (record_id, edited_at desc);

alter table public.vsr_audit_log enable row level security;
drop policy if exists "vsr_audit_log read" on public.vsr_audit_log;
create policy "vsr_audit_log read" on public.vsr_audit_log for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.vsr_audit_log from anon, authenticated;
grant select on public.vsr_audit_log to anon, authenticated;

-- 3 ── Trigger ───────────────────────────────────────────────────────────
create or replace function public.vsr_prediction_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Prediction inputs/outputs: a change to any of these is an "edit"
  pred_fields text[] := array[
    'qc_number','qc_model','qc_speed','cmph',
    'f1','f2','f3','f4','f5','f6','f7','f8',
    'container_min','gantry_min','buffer_min','total_min',
    'predicted_last_lift_time','suggested_srt',
    'predicted_last_lift_at','suggested_srt_at',
    'prediction_remarks'];
  -- Re-evaluated results (logged alongside an edit on completed records)
  derived_fields text[] := array['srt_window_start','srt_window_end','srt_class','deviation_minutes'];
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  diff jsonb := '{}'::jsonb;
  k text;
begin
  -- Only an already-saved prediction can be "edited"
  if OLD.predicted_last_lift_time is not null then
    foreach k in array pred_fields loop
      if (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
      end if;
    end loop;
  end if;

  if diff = '{}'::jsonb then
    -- Not a prediction edit: the edit-tracking columns can't be changed by the app
    NEW.prediction_edited         := OLD.prediction_edited;
    NEW.prediction_edit_count     := OLD.prediction_edit_count;
    NEW.prediction_edit_reason    := OLD.prediction_edit_reason;
    NEW.prediction_last_edited_by := OLD.prediction_last_edited_by;
    NEW.prediction_last_edited_at := OLD.prediction_last_edited_at;
    NEW.edit_reason_input := null;
    NEW.edit_by_input     := null;
    return NEW;
  end if;

  if coalesce(btrim(NEW.edit_reason_input), '') = '' then
    raise exception 'A reason is required to edit a saved prediction (record %)', OLD.id;
  end if;
  if coalesce(btrim(NEW.edit_by_input), '') = '' then
    raise exception 'Editor ID is required to edit a saved prediction (record %)', OLD.id;
  end if;

  foreach k in array derived_fields loop
    if (o -> k) is distinct from (n -> k) then
      diff := diff || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
    end if;
  end loop;

  NEW.prediction_edit_reason    := btrim(NEW.edit_reason_input);
  NEW.prediction_last_edited_by := btrim(NEW.edit_by_input);
  NEW.edit_reason_input         := null;
  NEW.edit_by_input             := null;
  NEW.prediction_edited         := true;
  NEW.prediction_edit_count     := coalesce(OLD.prediction_edit_count, 0) + 1;
  NEW.prediction_last_edited_at := now();
  NEW.prediction_base_at        := coalesce(OLD.prediction_base_at, NEW.prediction_base_at);

  insert into public.vsr_audit_log (record_id, vessel_name, action, changes, reason, edited_by)
  values (OLD.id::text, OLD.vessel_name, 'prediction_edit', diff,
          NEW.prediction_edit_reason, NEW.prediction_last_edited_by);

  return NEW;
end;
$$;

drop trigger if exists vsr_prediction_audit_trg on public.vsr_records;
create trigger vsr_prediction_audit_trg
  before update on public.vsr_records
  for each row execute function public.vsr_prediction_audit();

-- Refresh the API schema cache so the app sees the new columns immediately
notify pgrst, 'reload schema';
