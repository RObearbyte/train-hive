import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canChangeRsvp } from '@/features/rsvp/domain/rsvp';
import type { TrainingSession } from '@/lib/database.types';

import { fromSession, toTrainingInput, trainingFormSchema } from './schema';
import { deriveDisplayStatus } from './status';

const ZONE = 'Europe/Bucharest';
const NOW = new Date('2026-11-10T10:00:00Z');

function stored(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 'a', community_id: 'c', organizer_id: 'o', title: 'Run', description: null, activity_type: 'running',
    event_kind: 'training', event_subtype: 'running', starts_at: '2026-11-14T07:00:00.000Z', ends_at: null,
    rsvp_deadline: '2026-11-10T05:00:00.000Z', timezone: ZONE, location_name: 'Park', address: null,
    latitude: null, longitude: null, map_url: null, meeting_instructions: null, min_participants: 2,
    max_participants: 6, going_count: 2, status: 'scheduled', cancel_reason: null, decided_at: null,
    cancelled_at: null, cancelled_by: null, attendance_finalized_at: null, attendance_finalized_by: null,
    distance_km: null, elevation_gain_m: null, obstacle_count: null, event_notes: null,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as TrainingSession;
}

function issues(session: TrainingSession, change: Record<string, string>): string[] {
  const values = { ...fromSession(session), ...change };
  const result = trainingFormSchema({ mode: 'edit', timezone: ZONE, now: NOW, session }).safeParse(values);
  return result.success ? [] : result.error.issues.map((i) => String(i.path[0]));
}

describe('Q8 form versus server freeze rules', () => {
  // Q8-2 (fixed): the server freezes a training past its deadline before the finalizer runs; so does the form.
  it('a scheduled training past its deadline cannot change the limits or the deadline in the form either', () => {
    const s = stored();
    expect(issues(s, { maxParticipants: '7' })).toContain('maxParticipants');
    expect(issues(s, { minParticipants: '1' })).toContain('minParticipants');
    expect(issues(s, { deadlineDate: '2026-11-12', deadlineTime: '09:00' })).toContain('deadlineDate');
  });

  it('a non-training event past its deadline: deadline frozen, maximum editable down to going_count (matches the server)', () => {
    const s = stored({ event_kind: 'race', event_subtype: 'trail_running', min_participants: null, status: 'confirmed', max_participants: 5 });
    expect(issues(s, { deadlineDate: '2026-11-12', deadlineTime: '09:00' })).toContain('deadlineDate');
    expect(issues(s, { maxParticipants: '1' })).toContain('maxParticipants');
    expect(issues(s, { maxParticipants: '2' })).toEqual([]);
    expect(issues(s, { maxParticipants: '' })).toEqual([]);
  });

  it('p_input round trip: comma decimal becomes a JSON number, subtype change clears obstacles, no activity_type is sent', () => {
    const s = stored({
      event_kind: 'race', event_subtype: 'ocr', min_participants: null, status: 'confirmed',
      rsvp_deadline: '2026-11-12T05:00:00.000Z', distance_km: 21.1, elevation_gain_m: 450, obstacle_count: 12, event_notes: 'gloves',
    });
    const form = fromSession(s);
    expect(form.distanceKm).toBe('21.1');
    const input = toTrainingInput({ ...form, distanceKm: '21,5' }, ZONE, s);
    expect(input).toMatchObject({ event_kind: 'race', event_subtype: 'ocr', min_participants: null, distance_km: 21.5, elevation_gain_m: 450, obstacle_count: 12, event_notes: 'gloves' });
    const asAsphalt = toTrainingInput({ ...form, eventSubtype: 'asphalt_running' }, ZONE, s);
    expect(asAsphalt).toMatchObject({ obstacle_count: null, distance_km: 21.1 });
    expect('activity_type' in input).toBe(false);
  });

  it.each(['0', '0.00', '1000.01', '1.234', '1,234', '-1', '1e3', '12.', '.5', 'NaN'])('distance %j is refused by the form', (text) => {
    const s = stored({ event_kind: 'race', event_subtype: 'trail_running', min_participants: null, status: 'confirmed', rsvp_deadline: '2026-11-12T05:00:00.000Z' });
    expect(issues(s, { distanceKm: text })).toContain('distanceKm');
  });

  it('RSVP offer equals the server rule for every kind, status and deadline side', () => {
    for (const kind of ['training', 'race', 'sports_event', 'social'] as const) {
      for (const status of ['scheduled', 'confirmed'] as const) {
        for (const deadline of ['2026-11-10T09:59:59Z', '2026-11-10T10:00:00Z', '2026-11-10T10:00:01Z']) {
          const open = status === (kind === 'training' ? 'scheduled' : 'confirmed') && Date.parse(deadline) > NOW.getTime();
          const check = canChangeRsvp({ status, event_kind: kind, rsvp_deadline: deadline, going_count: 0, max_participants: null }, NOW);
          expect(check.allowed, `${kind}/${status}/${deadline}`).toBe(open);
        }
      }
    }
  });

  it('display status per kind: registration flips at the deadline instant, never a minimum state for a non-training', () => {
    const base = { status: 'confirmed' as const, cancel_reason: null, going_count: 0, min_participants: null };
    expect(deriveDisplayStatus({ ...base, event_kind: 'social', rsvp_deadline: '2026-11-10T10:00:01Z' }, NOW)).toBe('registration_open');
    expect(deriveDisplayStatus({ ...base, event_kind: 'social', rsvp_deadline: '2026-11-10T10:00:00Z' }, NOW)).toBe('registration_closed');
    expect(deriveDisplayStatus({ ...base, event_kind: 'race', status: 'scheduled', rsvp_deadline: '2026-11-09T00:00:00Z' }, NOW)).toBe('registration_closed');
  });
});

describe('Q8 vocabulary', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', 'components', file), 'utf8');
  // Q8-3 (fixed): the cancel dialog says "Keep event".
  it('the cancel dialog does not say "training" for a race or a social event', () => {
    expect(read('OrganizerActions.tsx')).not.toMatch(/cancelLabel="Keep training"/);
  });
  it('the minimum field and the confirmed banner are only rendered for trainings', () => {
    const form = read('TrainingForm.tsx');
    expect(form).toMatch(/session\?\.status === 'confirmed' && training/);
    expect(form).toMatch(/\{training \? \(\s*<FormTextField\s+control=\{control\}\s+name="minParticipants"/);
  });
});
