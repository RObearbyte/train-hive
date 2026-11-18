-- TrainHive: remove the temporary instant-dispatch diagnostics.
--
-- The cause (UPDATE without WHERE rejected by pg-safeupdate on API requests) is fixed in
-- 20261122000500_safeupdate_fix.sql and confirmed on the hosted project: entered -> called, 0-1 s
-- from queueing to delivery. This restores the lean trigger (no log writes), keeps the scrubbed
-- last_error record in private.dispatch_ping for future diagnosis, and drops the probe trigger,
-- the append-only log, the note helper and the probe columns.

create or replace function private.trigger_instant_dispatch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_ping boolean;
  v_step text := 'start';
  v_msg text;
  v_ctx text;
  v_detail text;
begin
  -- Cheap exits first, outside the exception block.
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  if not exists (select 1 from new_rows where next_attempt_at <= now()) then
    return null;
  end if;

  begin
    v_step := 'secrets';
    execute $q$
      select (select decrypted_secret from vault.decrypted_secrets where name = 'project_url'),
             (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')
    $q$ into v_url, v_secret;
    if v_url is null or v_secret is null then
      return null;
    end if;

    -- The debounce claim comes last among the locks (see 20261121000100_instant_dispatch.sql).
    -- Every UPDATE needs a WHERE clause: API requests run with pg-safeupdate.
    v_step := 'debounce';
    select true into v_ping
    from private.dispatch_ping
    where last_called < clock_timestamp() - interval '2 seconds'
    for update skip locked;
    if v_ping is null then
      return null;
    end if;
    update private.dispatch_ping set last_called = clock_timestamp() where id;

    -- Asynchronous: queued now, sent by pg_net after this transaction commits.
    v_step := 'http_post';
    execute $q$
      select net.http_post(
        url := $1 || '/functions/v1/dispatch-notifications',
        headers := jsonb_build_object('content-type', 'application/json', 'x-dispatch-secret', $2),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      )
    $q$ using v_url, v_secret;
  exception
    when others then
      get stacked diagnostics v_msg = message_text, v_ctx = pg_exception_context;
      -- The warning stays message-free; the details (URL and secret scrubbed) go to the owner-only row.
      raise warning 'TrainHive: instant dispatch skipped (sqlstate %)', sqlstate;
      v_detail := left(
        v_step || ' ' || sqlstate || ': '
        || replace(replace(coalesce(v_msg, '') || ' | ' || coalesce(v_ctx, ''),
                           coalesce(v_secret, '-'), '***'),
                   coalesce(v_url, '-'), '<url>'),
        800);
      begin
        perform 1 from private.dispatch_ping for update skip locked;
        if found then
          update private.dispatch_ping
          set last_error = v_detail, last_error_at = clock_timestamp()
          where id;
        end if;
      exception
        when others then
          null;
      end;
  end;
  return null;
end;
$$;

revoke all on function private.trigger_instant_dispatch() from public, anon, authenticated, service_role;

drop trigger if exists notification_delivery_jobs_probe on public.notification_delivery_jobs;
drop function if exists private.trigger_dispatch_probe();
drop function if exists private.dispatch_note(text);
drop table if exists private.dispatch_probe_log;

alter table private.dispatch_ping
  drop column if exists last_seen_at,
  drop column if exists last_exit;
