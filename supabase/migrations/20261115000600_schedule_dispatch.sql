-- TrainHive M3-B2: invoke the dispatch-notifications Edge Function every minute.
--
-- Needs pg_cron AND pg_net. No-op when either is unavailable (the embedded-Postgres test
-- harness); a listed-but-unusable extension only raises a warning naming the manual step.
-- Idempotent: a job with the same name is unscheduled first.
--
-- No secret lives in this migration. The cron command reads Supabase Vault at run time:
--   vault secret `project_url`      e.g. https://<ref>.supabase.co
--   vault secret `dispatch_secret`  the same value as the function secret DISPATCH_SECRET
-- Until both exist the job runs but sends nothing (the subquery yields no row, so no request
-- is made). See docs/PUSH_SETUP.md.

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
          timeout_milliseconds := 20000
        )
        where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
          and exists (select 1 from vault.decrypted_secrets where name = 'dispatch_secret')
        $cmd$
      );
    exception
      when others then
        raise warning
          'TrainHive: could not schedule push dispatch (%: %). Push notifications will NOT be '
          'delivered until this is done manually: enable pg_cron and pg_net, store the vault '
          'secrets project_url and dispatch_secret, and schedule the job as described in '
          'docs/PUSH_SETUP.md.',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;
