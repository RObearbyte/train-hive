-- TrainHive: log the entry and every error of the instant-dispatch trigger to the append-only log
-- (temporary diagnostic, see 20261122000300_dispatch_probe_log.sql).
--
-- Live announcements show 'jobs_insert_statement' from the independent probe trigger, but nothing
-- from this trigger, while the same code path run from the SQL editor logs 'called'. The error
-- handler used to record only in the shared ping row (skip-locked), which can silently write
-- nothing. Now an 'entered' line is written first and the error text (URL and secret scrubbed)
-- goes to the log, which never waits and never raises.

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
  perform private.dispatch_note('entered');

  -- Cheap exits first, outside the exception block.
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    perform private.dispatch_note('no_net_or_vault');
    return null;
  end if;
  if not exists (select 1 from new_rows where next_attempt_at <= now()) then
    perform private.dispatch_note('nothing_due');
    return null;
  end if;

  begin
    v_step := 'secrets';
    execute $q$
      select (select decrypted_secret from vault.decrypted_secrets where name = 'project_url'),
             (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')
    $q$ into v_url, v_secret;
    if v_url is null or v_secret is null then
      perform private.dispatch_note('secrets_null');
      return null;
    end if;

    -- The debounce claim comes last among the locks (see 20261121000100_instant_dispatch.sql).
    v_step := 'debounce';
    select true into v_ping
    from private.dispatch_ping
    where last_called < clock_timestamp() - interval '2 seconds'
    for update skip locked;
    if v_ping is null then
      perform private.dispatch_note('debounced');
      return null;
    end if;
    update private.dispatch_ping set last_called = clock_timestamp();

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
    perform private.dispatch_note('called');
  exception
    when others then
      get stacked diagnostics v_msg = message_text, v_ctx = pg_exception_context;
      -- The warning stays message-free, as before.
      raise warning 'TrainHive: instant dispatch skipped (sqlstate %)', sqlstate;
      v_detail := left(
        v_step || ' ' || sqlstate || ': '
        || replace(replace(coalesce(v_msg, '') || ' | ' || coalesce(v_ctx, ''),
                           coalesce(v_secret, '-'), '***'),
                   coalesce(v_url, '-'), '<url>'),
        800);
      -- Append-only log first (never waits), then the shared row best-effort.
      perform private.dispatch_note('error:' || v_detail);
      begin
        perform 1 from private.dispatch_ping for update skip locked;
        if found then
          update private.dispatch_ping
          set last_error = v_detail, last_error_at = clock_timestamp();
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
