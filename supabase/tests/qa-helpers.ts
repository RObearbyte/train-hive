import { admin, RAISED, type Session } from './helpers';

/**
 * Shared helpers for the independent QA suites (`qa-*.test.ts`).
 * Not a test file. Everything here is test-only and leaves no trace in the migrations.
 */

export const raised = (message: string) => ({ code: RAISED, message });

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `<SQLSTATE>:<message>` of a thrown pg error, e.g. `P0001:rsvp_closed`. */
export function errorKey(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return `${e.code ?? 'no-code'}:${e.message ?? String(error)}`;
}

/**
 * Collects the outcome of operations that run in a concurrent storm. Business errors matching
 * `allowed` are counted; everything else (deadlocks, constraint violations, serialization
 * failures, internal errors) is kept in `unexpected` and must be empty at the end.
 */
export class Outcomes {
  readonly counts = new Map<string, number>();
  readonly unexpected: string[] = [];

  private count(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Returns the value on success, or undefined when the operation raised. */
  async run<T>(label: string, allowed: RegExp, op: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await op();
      this.count(`${label}:ok`);
      return value;
    } catch (error) {
      const key = errorKey(error);
      this.count(`${label}:${key}`);
      if (!allowed.test(key)) this.unexpected.push(`${label} -> ${key}`);
      return undefined;
    }
  }

  total(prefix: string): number {
    let sum = 0;
    for (const [key, n] of this.counts) if (key.startsWith(prefix)) sum += n;
    return sum;
  }
}

/** The form a client would send back for an existing session (every key, ISO instants). */
export function formOf(session: Session, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: session.title,
    description: session.description,
    activity_type: session.activity_type,
    starts_at: session.starts_at.toISOString(),
    ends_at: session.ends_at?.toISOString() ?? null,
    rsvp_deadline: session.rsvp_deadline.toISOString(),
    timezone: session.timezone,
    location_name: session.location_name,
    address: session.address,
    latitude: session.latitude,
    longitude: session.longitude,
    map_url: session.map_url,
    meeting_instructions: session.meeting_instructions,
    min_participants: session.min_participants,
    max_participants: session.max_participants,
    ...overrides,
  };
}

/** Time travel: the RSVP deadline of a session becomes `ms` milliseconds from now (server clock). */
export async function deadlineIn(sessionId: string, ms: number): Promise<void> {
  await admin.query(
    `update public.training_sessions
     set rsvp_deadline = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
     where id = $1`,
    [sessionId, ms],
  );
}

/** Resolves once `count` backends running a query that contains `fragment` wait for a lock. */
export async function waitForBlocked(fragment: string, count = 1): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and pid <> pg_backend_pid() and query like $1`,
      [`%${fragment}%`],
    );
    if (rows[0].n >= count) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${count} blocked backend(s) running "${fragment}"`);
}

// Session audit ---------------------------------------------------------------------------------
// A test-only AFTER UPDATE trigger that records every change of a training session, together
// with the real number of `going` rows visible to the writing transaction at that moment. It
// lets a test check invariants at EVERY committed write of a concurrent run, not only at the end.

export async function installSessionAudit(): Promise<void> {
  await admin.query(`
    create schema if not exists qa;
    drop trigger if exists zz_qa_session_audit on public.training_sessions;
    drop table if exists qa.session_audit;
    create table qa.session_audit (
      seq bigserial primary key,
      session_id uuid not null,
      at timestamptz not null,
      old_status text, new_status text,
      old_reason text, new_reason text,
      old_decided timestamptz, new_decided timestamptz,
      old_going integer, new_going integer,
      old_min integer, new_min integer,
      old_max integer, new_max integer,
      old_deadline timestamptz, new_deadline timestamptz,
      real_going integer
    );
    create or replace function qa.audit_session() returns trigger
    language plpgsql security definer set search_path = '' as $fn$
    begin
      insert into qa.session_audit (
        session_id, at, old_status, new_status, old_reason, new_reason, old_decided, new_decided,
        old_going, new_going, old_min, new_min, old_max, new_max, old_deadline, new_deadline,
        real_going
      ) values (
        new.id, clock_timestamp(), old.status, new.status, old.cancel_reason, new.cancel_reason,
        old.decided_at, new.decided_at, old.going_count, new.going_count,
        old.min_participants, new.min_participants, old.max_participants, new.max_participants,
        old.rsvp_deadline, new.rsvp_deadline,
        (select count(*) from public.training_rsvps r
         where r.session_id = new.id and r.response = 'going')
      );
      return null;
    end;
    $fn$;
    create trigger zz_qa_session_audit
      after update on public.training_sessions
      for each row execute function qa.audit_session();
  `);
}

export async function removeSessionAudit(): Promise<void> {
  await admin.query(`
    drop trigger if exists zz_qa_session_audit on public.training_sessions;
    drop schema if exists qa cascade;
  `);
}

export async function clearSessionAudit(): Promise<void> {
  await admin.query('truncate table qa.session_audit');
}

export interface AuditViolation {
  rule: string;
  seq: number;
  session_id: string;
  detail: string;
}

const DETAIL = `format('%s/%s -> %s/%s going %s->%s (real %s) min %s->%s max %s->%s late by %s',
  old_status, old_reason, new_status, new_reason, old_going, new_going, real_going,
  old_min, new_min, old_max, new_max, at - old_deadline)`;

/**
 * Invariants checked on every recorded session write:
 *  - transition: only scheduled -> confirmed | cancelled, and confirmed -> cancelled by organizer.
 *  - count: going_count equals the real number of going rows.
 *  - decision: the finalizer decides only at or after the deadline, confirmed iff going >= min.
 *  - decided-frozen: after the decision, deadline / limits / count / decided_at never change.
 *  - deadline-frozen: on a scheduled session past its deadline, deadline and limits never change.
 *  - late-rsvp (optional): on a scheduled session past its deadline, the count never changes.
 * `toleranceMs` absorbs the time between an RPC's clock check and the trigger's clock reading.
 */
export async function auditViolations(
  options: { lateRsvp?: boolean; toleranceMs?: number } = {},
): Promise<AuditViolation[]> {
  const { lateRsvp = false, toleranceMs = 500 } = options;
  const { rows } = await admin.query<AuditViolation>(
    `with a as (select *, ${DETAIL} as detail from qa.session_audit),
     late as (select make_interval(secs => $1::double precision / 1000) as tolerance)
     select 'transition' as rule, seq::int, session_id, detail from a
       where old_status <> new_status
         and not (old_status = 'scheduled' and new_status in ('confirmed', 'cancelled'))
         and not (old_status = 'confirmed' and new_status = 'cancelled' and new_reason = 'organizer')
     union all
     select 'count', seq::int, session_id, detail from a
       where new_going <> real_going
     union all
     select 'decision', seq::int, session_id, detail from a
       where old_decided is null and new_decided is not null
         and not (
           old_status = 'scheduled'
           and at >= old_deadline
           and (
             (new_status = 'confirmed' and new_reason is null and new_going >= new_min)
             or (new_status = 'cancelled' and new_reason = 'insufficient_participation'
                 and new_going < new_min)
           )
         )
     union all
     select 'decided-frozen', seq::int, session_id, detail from a
       where old_status <> 'scheduled'
         and (new_min, new_max, new_deadline, new_going, new_decided)
             is distinct from (old_min, old_max, old_deadline, old_going, old_decided)
     union all
     select 'deadline-frozen', seq::int, session_id, detail from a, late
       where old_status = 'scheduled' and new_status = 'scheduled'
         and at > old_deadline + late.tolerance
         and (new_min, new_max, new_deadline) is distinct from (old_min, old_max, old_deadline)
     union all
     select 'late-rsvp', seq::int, session_id, detail from a, late
       where $2::boolean
         and old_status = 'scheduled'
         and at > old_deadline + late.tolerance
         and new_going <> old_going
     order by 2`,
    [toleranceMs, lateRsvp],
  );
  return rows;
}
