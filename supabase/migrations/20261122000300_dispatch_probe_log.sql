-- TrainHive: append-only probe log for the instant-dispatch trigger (temporary diagnostic).
--
-- Live announcements left private.dispatch_ping untouched although the trigger works from the SQL
-- editor. The ping row is written with FOR UPDATE SKIP LOCKED, which could hide a write. This adds
-- an append-only log (inserts never wait on or skip anything) and an independent statement trigger
-- that logs every INSERT statement on notification_delivery_jobs, so a live run shows:
--   select at, exit, rows_inserted from private.dispatch_probe_log order by id desc limit 20;
-- 'jobs_insert_statement' = triggers do fire for live inserts; the main trigger's own exits are
-- logged too (entered / no_net_or_vault / nothing_due / secrets_null / debounced / called / error).
-- Remove this table, the probe trigger and the log calls once the cause is understood.

create table private.dispatch_probe_log (
  id bigserial primary key,
  at timestamptz not null default clock_timestamp(),
  exit text not null,
  rows_inserted integer
);
revoke all on table private.dispatch_probe_log from public, anon, authenticated, service_role;
revoke all on sequence private.dispatch_probe_log_id_seq from public, anon, authenticated, service_role;

-- dispatch_note now also appends to the log (never raises, never waits).
create or replace function private.dispatch_note(p_exit text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into private.dispatch_probe_log (exit) values (left(p_exit, 200));
  exception
    when others then
      null;
  end;
  begin
    perform 1 from private.dispatch_ping for update skip locked;
    if found then
      update private.dispatch_ping
      set last_seen_at = clock_timestamp(), last_exit = left(p_exit, 200);
    end if;
  exception
    when others then
      null;
  end;
end;
$$;
revoke all on function private.dispatch_note(text) from public, anon, authenticated, service_role;

-- Independent probe: fires for every INSERT statement on the jobs table.
create or replace function private.trigger_dispatch_probe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  select count(*) into v_rows from new_rows;
  begin
    insert into private.dispatch_probe_log (exit, rows_inserted) values ('jobs_insert_statement', v_rows);
    delete from private.dispatch_probe_log where at < clock_timestamp() - interval '2 days';
  exception
    when others then
      null;
  end;
  return null;
end;
$$;
revoke all on function private.trigger_dispatch_probe() from public, anon, authenticated, service_role;

create trigger notification_delivery_jobs_probe
  after insert on public.notification_delivery_jobs
  referencing new table as new_rows
  for each statement
  execute function private.trigger_dispatch_probe();
