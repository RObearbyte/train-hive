import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { asUser, closeDb, createPack, getSession, realGoingCount, resetData, rpc, setRsvp } from './helpers';
import { Outcomes } from './qa-helpers';
import { createEvent, eventFormOf, type EventSession, updateEvent } from './events-helpers';

beforeEach(resetData);
afterAll(closeDb);

describe('Events (P1) concurrency', () => {
  it('an RSVP burst on a capacity-limited race admits exactly the capacity', async () => {
    const { communityId, organizerId, memberIds } = await createPack(20);
    const race = await createEvent(organizerId, communityId, 'race', { max_participants: 5 });
    const outcomes = new Outcomes();
    await Promise.all(
      memberIds.map((memberId) => outcomes.run('rsvp', /^P0001:session_full$/, () => setRsvp(memberId, race.id, 'going'))),
    );
    expect(outcomes.unexpected).toEqual([]);
    expect(outcomes.counts.get('rsvp:ok')).toBe(5);
    expect(outcomes.counts.get('rsvp:P0001:session_full')).toBe(15);
    const stored = await getSession(race.id);
    expect(stored).toMatchObject({ going_count: 5, status: 'confirmed' });
    expect(await realGoingCount(race.id)).toBe(5);
  });

  it('going / not going storms keep going_count exact on a social event', async () => {
    const { communityId, organizerId, memberIds } = await createPack(12);
    const social = await createEvent(organizerId, communityId, 'social', { max_participants: 6 });
    const outcomes = new Outcomes();
    await Promise.all(
      memberIds.flatMap((memberId, i) => [
        outcomes.run('a', /^P0001:session_full$/, () => setRsvp(memberId, social.id, 'going')),
        outcomes.run('b', /^P0001:session_full$/, () => setRsvp(memberId, social.id, i % 2 === 0 ? 'not_going' : 'going')),
      ]),
    );
    expect(outcomes.unexpected).toEqual([]);
    const stored = await getSession(social.id);
    expect(stored.going_count).toBe(await realGoingCount(social.id));
    expect(stored.going_count).toBeLessThanOrEqual(6);
  });

  it('update_training lowering the maximum vs a burst of RSVPs: never above the maximum, count exact', async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetData();
      const { communityId, organizerId, memberIds } = await createPack(8);
      const race = await createEvent(organizerId, communityId, 'race', { max_participants: 10 });
      const outcomes = new Outcomes();
      const update = outcomes.run('update', /^P0001:validation_failed:max_participants$/, () =>
        updateEvent(organizerId, race.id, eventFormOf(race, { max_participants: 3 })),
      );
      const rsvps = memberIds.map((memberId) =>
        outcomes.run('rsvp', /^P0001:session_full$/, () => setRsvp(memberId, race.id, 'going')),
      );
      await Promise.all([update, ...rsvps]);
      expect(outcomes.unexpected).toEqual([]);

      const stored = (await getSession(race.id)) as unknown as EventSession;
      expect(stored.going_count).toBe(await realGoingCount(race.id));
      if (outcomes.counts.get('update:ok') === 1) {
        expect(stored.max_participants).toBe(3);
        expect(stored.going_count).toBeLessThanOrEqual(3);
      } else {
        expect(stored.max_participants).toBe(10);
        expect(stored.going_count).toBeGreaterThan(3);
      }
    }
  });

  it('member removal vs RSVPs on an open race: no deadlock, removed members hold no place', async () => {
    const { communityId, organizerId, memberIds } = await createPack(10);
    const race = await createEvent(organizerId, communityId, 'race', { max_participants: 20 });
    const removed = memberIds.slice(0, 5);
    const outcomes = new Outcomes();
    await Promise.all([
      ...memberIds.map((memberId) =>
        outcomes.run('rsvp', /^P0001:not_a_member$/, () => setRsvp(memberId, race.id, 'going')),
      ),
      ...removed.map((memberId) =>
        outcomes.run('remove', /^$/, () =>
          asUser(organizerId, (db) => rpc(db, 'remove_member', [communityId, memberId])),
        ),
      ),
    ]);
    expect(outcomes.unexpected).toEqual([]);
    const stored = await getSession(race.id);
    expect(stored.going_count).toBe(await realGoingCount(race.id));
    expect(stored.going_count).toBe(5);
  });
});
