-- TrainHive: make the instant-dispatch trigger explain itself when it skips.
--
-- On the hosted project the trigger logged "instant dispatch skipped (sqlstate 21000)" although
-- every step works when run by hand. The log line carries only the SQLSTATE (deliberately), so the
-- failing step was invisible. This migration records the failing step and the error text (with the
-- project URL and the dispatch secret scrubbed out) in private.dispatch_ping, readable only by the
-- database owner:  select last_error, last_error_at from private.dispatch_ping;
--
-- Behaviour is otherwise unchanged: errors are still swallowed, the warning text is unchanged, the
-- debounce claim is still last and still skip-locked, and the dynamic SQL is still constant text
-- with bound values. Recording the error uses skip-locked as well, so it never waits.

alter table private.dispatch_ping
  add column last_error text,
  add column last_error_at timestamptz;

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
    v_step := 'debounce';
    select true into v_ping
    from private.dispatch_ping
    where last_called < clock_timestamp() - interval '2 seconds'
    for update skip locked;
    if v_ping is null then
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
  exception
    when others then
      get stacked diagnostics v_msg = message_text, v_ctx = pg_exception_context;
      -- The warning stays message-free, as before.
      raise warning 'TrainHive: instant dispatch skipped (sqlstate %)', sqlstate;
      -- Record where it failed, with the URL and secret scrubbed. Never waits, never raises.
      begin
        perform 1 from private.dispatch_ping for update skip locked;
        if found then
          update private.dispatch_ping
          set last_error = left(
                v_step || ' ' || sqlstate || ': '
                || replace(replace(coalesce(v_msg, '') || ' | ' || coalesce(v_ctx, ''),
                                   coalesce(v_secret, '-'), '***'),
                           coalesce(v_url, '-'), '<url>'),
                800),
              last_error_at = clock_timestamp();
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
