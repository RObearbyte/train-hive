import { admin } from './helpers';
import { DAY, HOUR, prng, ZONES, type Kind, type Model, type Outcome, type Person, type Resp, type Sess } from './qa-stats-reference';
import { SeasonBuilder } from './stats-helpers';

/** Seeded random seasons for the QA suites (database and model built together). Not a test file. */

export const BASE = Date.parse('2026-11-10T12:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export interface World {
  model: Model;
  season: SeasonBuilder;
  organizer: Person;
  rand: () => number;
}

export const pick = <T,>(rand: () => number, items: T[]): T => items[Math.floor(rand() * items.length)];

/** Builds a random season in the database and the same season in the model. */
export async function buildWorld(seed: number, baseMs: number, edges: boolean): Promise<World> {
  const rand = prng(seed);
  const tz = ZONES[seed % ZONES.length];
  const season = await SeasonBuilder.create(tz, `Season ${seed}`);
  const model: Model = { tz, people: [], sessions: [] };

  const addPerson = async (name: string, role: 'organizer' | 'member', status: 'active' | 'removed', joinedMs: number) => {
    const id = await season.person({ name, role, status, joinedAt: iso(joinedMs) });
    const p: Person = { id, name, role, status, joinedMs };
    model.people.push(p);
    return p;
  };

  const organizer = await addPerson('Organizer', 'organizer', 'active', baseMs - 400 * DAY);
  const memberCount = 4 + Math.floor(rand() * 6);
  for (let i = 0; i < memberCount; i += 1) {
    const early = rand() < 0.5;
    const joined = early ? baseMs - (300 + rand() * 50) * DAY : baseMs - rand() * 140 * DAY;
    await addPerson(`Member ${String(i).padStart(2, '0')}`, 'member', rand() < 0.15 ? 'removed' : 'active', Math.floor(joined));
  }

  // Session starts: unique, never within ten minutes of a window edge in live mode.
  const used = new Set<number>();
  const startOf = (hoursAgo: number) => {
    let ms = Math.floor(baseMs - hoursAgo * HOUR);
    if (!edges) {
      for (const days of [7, 30, 90]) if (Math.abs(baseMs - ms - days * DAY) < 10 * 60_000) ms -= 17 * 60_000;
    }
    while (used.has(ms)) ms -= 60_000;
    used.add(ms);
    return ms;
  };
  const starts: number[] = [];
  const count = 8 + Math.floor(rand() * 9);
  for (let i = 0; i < count; i += 1) starts.push(startOf(2 + rand() * 24 * 130));
  if (edges) {
    starts.push(Math.floor(baseMs - 7 * DAY), Math.floor(baseMs - 7 * DAY - 1), Math.floor(baseMs - 30 * DAY));
    starts.push(Math.floor(baseMs - 90 * DAY), Math.floor(baseMs - 90 * DAY - 1), Math.floor(baseMs));
    for (const ms of starts.slice(-6)) used.add(ms);
  }

  for (const [i, startMs] of starts.entries()) {
    const edgeSession = i >= count;
    const roll = rand();
    const kind: Kind = edgeSession
      ? 'completed'
      : roll < 0.68
        ? 'completed'
        : roll < 0.78
          ? 'confirmed'
          : roll < 0.83
            ? 'scheduled'
            : roll < 0.92
              ? 'cancelled_min'
              : 'cancelled_organizer';
    const id = await season.session({ at: iso(startMs), kind, title: `Session ${i}` });
    const s: Sess = { id, title: `Session ${i}`, startMs, kind, rsvps: new Map(), recs: new Map() };
    model.sessions.push(s);

    const neverMarked = kind === 'completed' && rand() < 0.15;
    for (const p of model.people) {
      if (p.joinedMs <= startMs) {
        const r = rand();
        const resp: Resp | null = r < 0.62 ? 'going' : r < 0.74 ? 'not_going' : r < 0.8 ? 'no_response' : null;
        if (resp !== null) {
          await season.rsvp(id, p.id, resp);
          s.rsvps.set(p.id, resp);
        }
        if (resp === 'going') {
          const o = rand();
          const status: Outcome | null = neverMarked
            ? o < 0.5
              ? 'unrecorded'
              : null
            : o < 0.7
              ? 'present'
              : o < 0.82
                ? 'absent'
                : o < 0.92
                  ? 'unrecorded'
                  : null;
          if (status !== null) {
            await season.mark(id, p.id, status);
            s.recs.set(p.id, { status, walkIn: false });
          }
        } else if (kind === 'completed' && !neverMarked && rand() < 0.12) {
          await season.walkIn(id, p.id);
          s.recs.set(p.id, { status: 'present', walkIn: true });
        }
      } else if (kind === 'completed' && rand() < 0.4) {
        // Joined after the session started and was added as a walk-in (not eligible, still a real attendance).
        await season.walkIn(id, p.id);
        s.recs.set(p.id, { status: 'present', walkIn: true });
      }
    }
  }
  return { model, season, organizer, rand };
}

/** Random changes applied to the database and to the model alike. */
export async function mutate(world: World): Promise<string[]> {
  const { model, rand, season } = world;
  const log: string[] = [];
  const completed = model.sessions.filter((s) => s.kind === 'completed');

  // Corrections: present <-> absent <-> unrecorded, and a deleted record.
  for (let n = 0; n < 5; n += 1) {
    const s = pick(rand, completed);
    const entries = [...s.recs.entries()].filter(([, r]) => !r.walkIn);
    if (entries.length === 0) continue;
    const [uid, rec] = pick(rand, entries);
    if (rand() < 0.2) {
      await admin.query('delete from public.attendance_records where session_id = $1 and user_id = $2', [s.id, uid]);
      s.recs.delete(uid);
      log.push(`delete record ${s.title}`);
    } else {
      const next = pick(rand, (['present', 'absent', 'unrecorded'] as Outcome[]).filter((o) => o !== rec.status));
      await admin.query('update public.attendance_records set status = $3 where session_id = $1 and user_id = $2', [s.id, uid, next]);
      rec.status = next;
      log.push(`correct ${s.title} ${rec.status}`);
    }
  }

  // Moved sessions (also across window boundaries): the current starts_at is the one that counts.
  const used = new Set(model.sessions.map((s) => s.startMs));
  for (let n = 0; n < 2; n += 1) {
    const s = pick(rand, model.sessions);
    let startMs = Math.floor(BASE - (1 + rand() * 120) * DAY);
    while (used.has(startMs)) startMs -= 60_000;
    used.add(startMs);
    await admin.query(
      `update public.training_sessions
       set starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '1 hour', rsvp_deadline = $2::timestamptz - interval '2 hours'
       where id = $1`,
      [s.id, iso(startMs)],
    );
    s.startMs = startMs;
    log.push(`move ${s.title}`);
  }

  // A member is removed; one organizer-less change in the zone.
  const removable = model.people.filter((p) => p.role === 'member' && p.status === 'active');
  if (removable.length > 0) {
    const p = pick(rand, removable);
    await admin.query("update public.memberships set status = 'removed' where community_id = $1 and user_id = $2", [season.communityId, p.id]);
    p.status = 'removed';
    log.push(`remove ${p.name}`);
  }
  const tz = pick(rand, ZONES.filter((z) => z !== model.tz));
  await admin.query('update public.communities set timezone = $2 where id = $1', [season.communityId, tz]);
  model.tz = tz;
  log.push(`timezone ${tz}`);
  return log;
}

