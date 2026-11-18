-- TrainHive: near-instant push delivery.
--
-- Until now a queued notification waited for the next minute of the pg_cron job. This adds a
-- statement-level AFTER INSERT trigger on notification_delivery_jobs that calls the
-- dispatch-notifications Edge Function right away. The cron job stays as the safety net (rows
-- scheduled for later, skipped or failed calls, storms, a missing extension).
--
-- Why this cannot hurt the transaction that creates notifications:
--   * pg_net requests are asynchronous: net.http_post only writes a row to pg_net's queue inside
--     the calling transaction; a background worker sends the request after the transaction has
--     committed (https://supabase.com/docs/guides/database/extensions/pg_net: "HTTP requests
--     are not started until the transaction is committed"). A rolled-back transaction rolls the
--     queue row back with it, so it sends nothing. The call therefore never waits for the network.
--   * The whole body is wrapped in an exception block that swallows every error and logs only
--     the SQLSTATE (never a message, which could echo a secret).
--   * pg_net, Vault or either secret missing (the local test database has none of them) is a
--     silent no-op. The function refers to net/vault only through dynamic SQL so it compiles
--     everywhere.
--
-- Statement level: one fan-out INSERT of N rows fires the trigger once (the NEW TABLE transition
-- relation lets it check the inserted rows). Only rows that are due now (next_attempt_at <=
-- now()) cause a call; jobs scheduled for later are left to the cron job.
--
-- Debounce / storm control: private.dispatch_ping holds one row. The function claims it with
--   select ... where last_called < clock_timestamp() - 2 s for update skip locked
-- followed by an update, so at most one immediate call every 2 seconds. Lock behaviour: the row
-- lock is taken LAST in the function and held until the creating transaction ends; it is the only
-- lock the function takes besides row-level inserts already done by the statement. Because it is
-- last, and because contenders use SKIP LOCKED (they never wait), it cannot take part in a
-- deadlock cycle with the transactions that create notifications and it never makes one wait.
-- A contender that finds the row locked or too recent simply skips; the running dispatcher
-- claims in batches for ~40 s and the cron job covers the remainder within a minute.
-- If the call itself raises, the exception block rolls the ping back to its previous value.

create table private.dispatch_ping (
  id boolean primary key default true,
  last_called timestamptz not null default '-infinity',
  constraint dispatch_ping_single_row check (id)
);
insert into private.dispatch_ping (id) values (true);
revoke all on table private.dispatch_ping from public, anon, authenticated, service_role;

create function private.trigger_instant_dispatch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_ping boolean;
begin
  -- Cheap exits first, outside the exception block.
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  if not exists (select 1 from new_rows where next_attempt_at <= now()) then
    return null;
  end if;

  begin
    execute $q$
      select (select decrypted_secret from vault.decrypted_secrets where name = 'project_url'),
             (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')
    $q$ into v_url, v_secret;
    if v_url is null or v_secret is null then
      return null;
    end if;

    -- The debounce claim comes last (see the lock notes above).
    select true into v_ping
    from private.dispatch_ping
    where last_called < clock_timestamp() - interval '2 seconds'
    for update skip locked;
    if v_ping is null then
      return null;
    end if;
    update private.dispatch_ping set last_called = clock_timestamp();

    -- Asynchronous: queued now, sent by pg_net after this transaction commits.
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
      -- Never the message: it could contain a secret. The cron job delivers within a minute.
      raise warning 'TrainHive: instant dispatch skipped (sqlstate %)', sqlstate;
  end;
  return null;
end;
$$;

revoke all on function private.trigger_instant_dispatch() from public, anon, authenticated, service_role;

create trigger notification_delivery_jobs_instant_dispatch
  after insert on public.notification_delivery_jobs
  referencing new table as new_rows
  for each statement
  execute function private.trigger_instant_dispatch();
