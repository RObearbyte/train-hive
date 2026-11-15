-- TrainHive M3-B1: pg_cron jobs for announcements, reminders and outbox housekeeping, next to
-- the Milestone 1 finalizer (20261114000500_schedule_finalizer.sql), with the same pattern:
--   * no-op on databases without pg_cron (the embedded-Postgres test harness);
--   * idempotent: a job with the same name is unscheduled first;
--   * a pg_cron that is listed but unusable does not fail the migration, it raises a warning
--     naming the manual step.
-- The jobs run as the role that applies this migration (the function owner), which may always
-- execute the functions even though execute is otherwise granted to service_role only.
--
--   trainhive_publish_due_announcements   every minute   publish_due_announcements()
--   trainhive_training_reminders          every minute   enqueue_due_training_reminders()
--   trainhive_purge_notification_data     daily 03:17    purge_old_notification_data()
--
-- Push delivery itself is the Edge Function (M3-B2); it is invoked separately.

do $$
declare
  v_job record;
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;

      for v_job in
        select *
        from (values
          ('trainhive_publish_due_announcements', '* * * * *',
           'select public.publish_due_announcements()'),
          ('trainhive_training_reminders', '* * * * *',
           'select public.enqueue_due_training_reminders()'),
          ('trainhive_purge_notification_data', '17 3 * * *',
           'select public.purge_old_notification_data()')
        ) as j (name, schedule, command)
      loop
        perform cron.unschedule(c.jobid) from cron.job c where c.jobname = v_job.name;
        perform cron.schedule(v_job.name, v_job.schedule, v_job.command);
      end loop;
    exception
      when others then
        raise warning
          'TrainHive: could not schedule the notification jobs with pg_cron (%: %). '
          'Scheduled announcements will NOT be published and training reminders will NOT be '
          'sent until this is done manually: enable the pg_cron extension for the project, then '
          'run select cron.schedule(''trainhive_publish_due_announcements'', ''* * * * *'', '
          '''select public.publish_due_announcements()''); '
          'select cron.schedule(''trainhive_training_reminders'', ''* * * * *'', '
          '''select public.enqueue_due_training_reminders()''); '
          'select cron.schedule(''trainhive_purge_notification_data'', ''17 3 * * *'', '
          '''select public.purge_old_notification_data()'');',
          sqlstate, sqlerrm;
    end;
  end if;
end
$$;
