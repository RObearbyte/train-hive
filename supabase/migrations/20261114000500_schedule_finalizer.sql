-- TrainHive M1-B2: run finalize_due_sessions() every minute with pg_cron, when pg_cron exists.
-- On databases without pg_cron (the embedded-Postgres test harness) this is a no-op.
-- Idempotent: an existing job with the same name is unscheduled first.
-- The job runs as the role that applies this migration (the function owner), which may always
-- execute the function even though execute is otherwise granted to service_role only.
-- If pg_cron is listed but cannot be created or used (not preloaded, missing privilege), the
-- migration does not fail: it raises a warning that names the manual step.

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;

      perform cron.unschedule(j.jobid)
      from cron.job j
      where j.jobname = 'trainhive_finalize_due_sessions';

      perform cron.schedule(
        'trainhive_finalize_due_sessions',
        '* * * * *',
        'select public.finalize_due_sessions()'
      );
    exception
      when others then
        raise warning
          'TrainHive: could not schedule finalize_due_sessions with pg_cron (%: %). '
          'Training sessions will NOT be confirmed or cancelled at their RSVP deadline until '
          'this is done manually: enable the pg_cron extension for the project, then run '
          'select cron.schedule(''trainhive_finalize_due_sessions'', ''* * * * *'', '
          '''select public.finalize_due_sessions()'');',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;
