-- TrainHive M3-B3: the dispatcher now keeps claiming for up to ~40 s per run (and may finish its
-- last requests up to ~100 s), so the pg_net call that starts it waits up to 120 s instead of
-- 20 s. Otherwise identical to 20261115000600_schedule_dispatch.sql (same guards, idempotent:
-- the job is unscheduled and scheduled again; no secret lives here). Overlapping runs are safe:
-- claim_notification_jobs never hands the same job to two workers.

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
      create extension if not exists pg_net with schema extensions;

      perform cron.unschedule(c.jobid) from cron.job c where c.jobname = 'trainhive_dispatch_notifications';
      perform cron.schedule(
        'trainhive_dispatch_notifications',
        '* * * * *',
        $cmd$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
                 || '/functions/v1/dispatch-notifications',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        )
        where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
          and exists (select 1 from vault.decrypted_secrets where name = 'dispatch_secret')
        $cmd$
      );
    exception
      when others then
        raise warning
          'TrainHive: could not reschedule push dispatch (%: %). Push notifications will NOT be '
          'delivered until this is done manually: enable pg_cron and pg_net, store the vault '
          'secrets project_url and dispatch_secret, and schedule the job as described in '
          'docs/PUSH_SETUP.md.',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;
