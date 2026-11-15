/**
 * M4-Q1: an independent reference implementation of the statistics, written from
 * docs/STATS_DEFINITIONS.md and the Milestone 4 section of docs/API_CONTRACT.md, without
 * reading the SQL. Pure TypeScript over an in-memory model of a season. Not a test file.
 *
 * Decisions follow the contract (not the loose spec wording): eligibility joined_at <= starts_at,
 * RSVP reliability over going RSVPs with a recorded outcome, attendance rate over every eligible
 * session (unrecorded stays in the denominator), rates rounded half up to one decimal.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export type Window = '7d' | '30d' | '90d' | 'all';
export type Resp = 'going' | 'not_going' | 'no_response';
export type Outcome = 'present' | 'absent' | 'unrecorded';
export type Kind = 'completed' | 'confirmed' | 'scheduled' | 'cancelled_min' | 'cancelled_organizer';

export interface Person {
  id: string;
  name: string;
  role: 'organizer' | 'member';
  status: 'active' | 'removed';
  joinedMs: number;
}

export interface Sess {
  id: string;
  title: string;
  startMs: number;
  kind: Kind;
  rsvps: Map<string, Resp>;
  recs: Map<string, { status: Outcome; walkIn: boolean }>;
}

export interface Model {
  tz: string;
  people: Person[];
  sessions: Sess[];
}

// Time zones ----------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant of local midnight of a calendar date (zones without a midnight gap only). */
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  const p = parts(t, tz);
  if (p.y !== y || p.m !== m || p.d !== d || p.h !== 0 || p.mi !== 0) throw new Error(`no local midnight ${y}-${m}-${d} in ${tz}`);
  return t;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export interface Bucket {
  period: string;
  from: number;
  to: number;
}

export function bucketOf(ms: number, unit: 'week' | 'month', tz: string): Bucket {
  const p = parts(ms, tz);
  if (unit === 'month') {
    const ny = p.m === 12 ? p.y + 1 : p.y;
    const nm = p.m === 12 ? 1 : p.m + 1;
    return { period: `${p.y}-${pad(p.m)}`, from: localMidnight(p.y, p.m, 1, tz), to: localMidnight(ny, nm, 1, tz) };
  }
  const day = Date.UTC(p.y, p.m - 1, p.d);
  const dow = new Date(day).getUTCDay();
  const monday = new Date(day - ((dow + 6) % 7) * DAY);
  const next = new Date(monday.getTime() + 7 * DAY);
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth() + 1;
  const d = monday.getUTCDate();
  return {
    period: `${y}-${pad(m)}-${pad(d)}`,
    from: localMidnight(y, m, d, tz),
    to: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz),
  };
}

function buckets(startMs: number, atMs: number, unit: 'week' | 'month', tz: string): Bucket[] {
  const out: Bucket[] = [];
  let b = bucketOf(startMs, unit, tz);
  while (b.from <= atMs) {
    out.push(b);
    b = bucketOf(b.to, unit, tz);
  }
  return out;
}

// Arithmetic ----------------------------------------------------------------------------------

/** round(100 * n / d, 1), half up, null when d = 0 (integer arithmetic: no float rounding). */
export function rate(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.floor((2000 * n + d) / (2 * d)) / 10;
}

/** round(total / count, 1), half up. */
export function average(total: number, count: number): number | null {
  if (count === 0) return null;
  return Math.floor((20 * total + count) / (2 * count)) / 10;
}

// Window and sets -----------------------------------------------------------------------------

const WINDOW_DAYS: Record<Exclude<Window, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function windowFrom(window: Window, atMs: number): number | null {
  return window === 'all' ? null : atMs - WINDOW_DAYS[window] * DAY;
}

function inWindow(startMs: number, from: number | null, atMs: number): boolean {
  return startMs <= atMs && (from === null || startMs >= from);
}

/** S: finalized, completed, not cancelled sessions in the window. */
export function setS(model: Model, window: Window, atMs: number): Sess[] {
  const from = windowFrom(window, atMs);
  return model.sessions.filter((s) => s.kind === 'completed' && inWindow(s.startMs, from, atMs));
}

// Member statistics ---------------------------------------------------------------------------

export interface HistoryRow {
  session_id: string;
  starts_at: number;
  rsvp_response: Resp;
  outcome: Outcome;
  is_walk_in: boolean;
}

export function memberRows(model: Model, person: Person, window: Window, atMs: number): HistoryRow[] {
  return setS(model, window, atMs)
    .filter((s) => person.joinedMs <= s.startMs)
    .map((s) => ({
      session_id: s.id,
      starts_at: s.startMs,
      rsvp_response: s.rsvps.get(person.id) ?? 'no_response',
      outcome: s.recs.get(person.id)?.status ?? 'unrecorded',
      is_walk_in: s.recs.get(person.id)?.walkIn ?? false,
    }))
    .sort((a, b) => b.starts_at - a.starts_at || (a.session_id < b.session_id ? 1 : -1));
}

export interface MemberCounts {
  eligible: number;
  attended: number;
  absent: number;
  not_recorded: number;
  recorded: number;
  attendance_rate: number | null;
  confirmed_rsvps: number;
  missed: number;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  rsvp_reliability: number | null;
  walk_ins: number;
}

export function countsOf(rows: HistoryRow[]): MemberCounts {
  const attended = rows.filter((r) => r.outcome === 'present').length;
  const absent = rows.filter((r) => r.outcome === 'absent').length;
  const going = rows.filter((r) => r.rsvp_response === 'going');
  const goingPresent = going.filter((r) => r.outcome === 'present').length;
  const goingRecorded = going.filter((r) => r.outcome !== 'unrecorded').length;
  return {
    eligible: rows.length,
    attended,
    absent,
    not_recorded: rows.length - attended - absent,
    recorded: attended + absent,
    attendance_rate: rate(attended, rows.length),
    confirmed_rsvps: going.length,
    missed: going.filter((r) => r.outcome === 'absent').length,
    rsvp_going_present: goingPresent,
    rsvp_going_recorded: goingRecorded,
    rsvp_reliability: rate(goingPresent, goingRecorded),
    walk_ins: rows.filter((r) => r.outcome === 'present' && r.is_walk_in).length,
  };
}

export interface MemberRef extends MemberCounts {
  window: Window;
  from: number | null;
  to: number;
  membership_status: 'active' | 'removed';
  role: 'organizer' | 'member';
  monthly: { period: string; from: number; to: number; eligible: number; attended: number; attendance_rate: number | null }[];
}

export function memberRef(model: Model, person: Person, window: Window, atMs: number): MemberRef {
  const rows = memberRows(model, person, window, atMs);
  const from = windowFrom(window, atMs);
  const first = from ?? (rows.length ? Math.min(...rows.map((r) => r.starts_at)) : null);
  const monthly =
    first === null
      ? []
      : buckets(first, atMs, 'month', model.tz).map((b) => {
          const inB = rows.filter((r) => r.starts_at >= b.from && r.starts_at < b.to);
          const attended = inB.filter((r) => r.outcome === 'present').length;
          return { period: b.period, from: b.from, to: b.to, eligible: inB.length, attended, attendance_rate: rate(attended, inB.length) };
        });
  return {
    window,
    from,
    to: atMs,
    membership_status: person.status,
    role: person.role,
    ...countsOf(rows),
    monthly,
  };
}

// Community statistics ------------------------------------------------------------------------

export interface CommunityRef {
  window: Window;
  from: number | null;
  to: number;
  completed_trainings: number;
  total_attendances: number;
  average_attendees: number | null;
  average_attendees_sessions: number;
  incomplete_sessions: number;
  rsvp_going_total: number;
  average_rsvp_participation: number | null;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  rsvp_conversion: number | null;
  active_members: number;
  members_attended: number;
  cancelled_insufficient_participation: number;
  cancelled_by_organizer: number;
  trend_unit: 'week' | 'month';
  trend: {
    period: string;
    from: number;
    to: number;
    sessions: number;
    present: number;
    incomplete_sessions: number;
    average_attendees: number | null;
  }[];
  top_sessions: { session_id: string; starts_at: number; present: number }[];
}

const presentCount = (s: Sess) => [...s.recs.values()].filter((r) => r.status === 'present').length;
const markedCount = (s: Sess) => [...s.recs.values()].filter((r) => r.status === 'present' || r.status === 'absent').length;
const goingCount = (s: Sess) => [...s.rsvps.values()].filter((r) => r === 'going').length;

export function communityRef(model: Model, window: Window, atMs: number): CommunityRef {
  const from = windowFrom(window, atMs);
  const S = setS(model, window, atMs);
  const complete = S.filter((s) => markedCount(s) > 0);
  const totalPresent = S.reduce((n, s) => n + presentCount(s), 0);
  let goingPresent = 0;
  let goingRecorded = 0;
  for (const s of S) {
    for (const [uid, resp] of s.rsvps) {
      if (resp !== 'going') continue;
      const st = s.recs.get(uid)?.status;
      if (st === 'present') goingPresent += 1;
      if (st === 'present' || st === 'absent') goingRecorded += 1;
    }
  }
  const goingTotal = S.reduce((n, s) => n + goingCount(s), 0);
  const active = model.people.filter((p) => p.status === 'active');
  const attendedIds = new Set<string>();
  for (const p of active) {
    if (memberRows(model, p, window, atMs).some((r) => r.outcome === 'present')) attendedIds.add(p.id);
  }
  const cancelled = model.sessions.filter(
    (s) => (s.kind === 'cancelled_min' || s.kind === 'cancelled_organizer') && inWindow(s.startMs, from, atMs),
  );
  const unit = window === '7d' || window === '30d' ? 'week' : 'month';
  const first = from ?? (S.length ? Math.min(...S.map((s) => s.startMs)) : null);
  const trend =
    first === null
      ? []
      : buckets(first, atMs, unit, model.tz).map((b) => {
          const inB = S.filter((s) => s.startMs >= b.from && s.startMs < b.to);
          const compl = inB.filter((s) => markedCount(s) > 0);
          const present = inB.reduce((n, s) => n + presentCount(s), 0);
          return {
            period: b.period,
            from: b.from,
            to: b.to,
            sessions: inB.length,
            present,
            incomplete_sessions: inB.length - compl.length,
            average_attendees: average(present, compl.length),
          };
        });
  const top = [...S]
    .sort((a, b) => presentCount(b) - presentCount(a) || b.startMs - a.startMs)
    .slice(0, 5)
    .map((s) => ({ session_id: s.id, starts_at: s.startMs, present: presentCount(s) }));
  return {
    window,
    from,
    to: atMs,
    completed_trainings: S.length,
    total_attendances: totalPresent,
    average_attendees: average(totalPresent, complete.length),
    average_attendees_sessions: complete.length,
    incomplete_sessions: S.length - complete.length,
    rsvp_going_total: goingTotal,
    average_rsvp_participation: average(goingTotal, S.length),
    rsvp_going_present: goingPresent,
    rsvp_going_recorded: goingRecorded,
    rsvp_conversion: rate(goingPresent, goingRecorded),
    active_members: active.length,
    members_attended: attendedIds.size,
    cancelled_insufficient_participation: cancelled.filter((s) => s.kind === 'cancelled_min').length,
    cancelled_by_organizer: cancelled.filter((s) => s.kind === 'cancelled_organizer').length,
    trend_unit: unit,
    trend,
    top_sessions: top,
  };
}

/** Test-side deep diff: returns human-readable paths where `actual` differs from `expected`. */
export function diff(actual: unknown, expected: unknown, path = ''): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${JSON.stringify(actual)}`];
    const out: string[] = [];
    if (actual.length !== expected.length) out.push(`${path}.length: expected ${expected.length}, got ${actual.length}`);
    for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) out.push(...diff(actual[i], expected[i], `${path}[${i}]`));
    return out;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    const out: string[] = [];
    for (const key of Object.keys(expected)) {
      out.push(...diff((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`));
    }
    return out;
  }
  return Object.is(actual, expected) ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

// Seeded generator ----------------------------------------------------------------------------

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zones without a midnight gap, covering half-hour DST (Lord Howe), southern DST, no DST and UTC+14. */
export const ZONES = [
  'Europe/Bucharest',
  'America/New_York',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'UTC',
  'America/Los_Angeles',
  'Pacific/Kiritimati',
  'Europe/London',
];
