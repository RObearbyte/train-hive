import { asUser, rpcRow, type Session, trainingInput } from './helpers';

/**
 * Helpers for the Events (P1) suites. Not a test file.
 * The table and RPC names stay `training_sessions` / `create_training`; "event" is UI vocabulary.
 */

export type EventKind = 'training' | 'race' | 'sports_event' | 'social';

export type EventSession = Omit<Session, 'min_participants'> & {
  min_participants: number | null;
  event_kind: EventKind;
  event_subtype: string;
  /** numeric(6,2): node-postgres returns it as a string. */
  distance_km: string | null;
  elevation_gain_m: number | null;
  obstacle_count: number | null;
  event_notes: string | null;
};

/** A default subtype per kind for fixtures. */
export const FIXTURE_SUBTYPE: Record<EventKind, string> = {
  training: 'running',
  race: 'trail_running',
  sports_event: 'crossfit_event',
  social: 'social_gathering',
};

export const KINDS: EventKind[] = ['training', 'race', 'sports_event', 'social'];

/**
 * A complete, valid `p_input` for an event of `kind`: the training fixture (starts in 3 days,
 * deadline in 2 days) with the kind's fields. Non-training kinds have no minimum and no
 * activity_type key (it is derived).
 */
export function eventInput(kind: EventKind, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = trainingInput();
  if (kind === 'training') {
    return { ...base, event_kind: 'training', event_subtype: 'running', ...overrides };
  }
  const rest: Record<string, unknown> = { ...base };
  delete rest.activity_type;
  return {
    ...rest,
    event_kind: kind,
    event_subtype: FIXTURE_SUBTYPE[kind],
    min_participants: null,
    ...overrides,
  };
}

export function createEvent(
  organizerId: string,
  communityId: string,
  kind: EventKind,
  overrides: Record<string, unknown> = {},
): Promise<EventSession> {
  return asUser(organizerId, (db) =>
    rpcRow<EventSession>(db, 'create_training', [communityId, JSON.stringify(eventInput(kind, overrides))]),
  );
}

/** Calls create_training with exactly `input` (no fixture defaults). */
export function createRaw(organizerId: string, communityId: string, input: unknown): Promise<EventSession> {
  return asUser(organizerId, (db) =>
    rpcRow<EventSession>(db, 'create_training', [communityId, JSON.stringify(input)]),
  );
}

export function updateEvent(userId: string, sessionId: string, input: Record<string, unknown>): Promise<EventSession> {
  return asUser(userId, (db) =>
    rpcRow<EventSession>(db, 'update_training', [sessionId, JSON.stringify(input)]),
  );
}

/** The full form a P1 client sends back for an existing event (every key, ISO instants). */
export function eventFormOf(session: EventSession, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: session.title,
    description: session.description,
    event_kind: session.event_kind,
    event_subtype: session.event_subtype,
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
    distance_km: session.distance_km === null ? null : Number(session.distance_km),
    elevation_gain_m: session.elevation_gain_m,
    obstacle_count: session.obstacle_count,
    event_notes: session.event_notes,
    ...overrides,
  };
}

/** The Milestone 1 form (no P1 keys), as an app build from before P1 sends it. */
export function legacyFormOf(session: EventSession, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
