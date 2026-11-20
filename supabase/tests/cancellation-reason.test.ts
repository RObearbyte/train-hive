import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { notifications } from './notifications-helpers';
import {
  addMember,
  admin,
  asAnon,
  cancelTraining,
  closeDb,
  createPack,
  createTraining,
  finalize,
  getSession,
  makeDue,
  RAISED,
  resetData,
  setRsvp,
} from './helpers';

const raised = (message: string) => ({ code: RAISED, message });
const CHECK_VIOLATION = '23514';
type WithReason = { cancellation_reason: string | null; status: string };

beforeEach(resetData);
afterAll(closeDb);

async function reasonOf(sessionId: string): Promise<string | null> {
  const row = (await getSession(sessionId)) as unknown as WithReason;
  return row.cancellation_reason;
}

describe('cancel_training with a reason', () => {
  it('stores the organizer note, trimmed', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    const cancelled = (await cancelTraining(
      organizerId,
      session.id,
      '  Storm warning.\nStay safe.  ',
    )) as unknown as WithReason;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellation_reason: 'Storm warning.\nStay safe.' });
    expect(await reasonOf(session.id)).toBe('Storm warning.\nStay safe.');
  });

  it('no reason, null, empty and whitespace-only all mean no reason', async () => {
    const { communityId, organizerId } = await createPack();
    for (const reason of [undefined, null, '', '   \n ']) {
      const session = await createTraining(organizerId, communityId);
      const cancelled = (await cancelTraining(organizerId, session.id, reason)) as unknown as WithReason;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancellation_reason).toBeNull();
    }
  });

  it('accepts exactly 300 characters and refuses 301 without cancelling', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await expect(cancelTraining(organizerId, session.id, 'x'.repeat(301))).rejects.toMatchObject(
      raised('validation_failed:cancellation_reason'),
    );
    expect(((await getSession(session.id)) as unknown as WithReason).status).not.toBe('cancelled');
    await cancelTraining(organizerId, session.id, 'x'.repeat(300));
    expect(await reasonOf(session.id)).toBe('x'.repeat(300));
  });

  it('refuses invisible-only text', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await expect(cancelTraining(organizerId, session.id, '​​')).rejects.toMatchObject(
      raised('validation_failed:cancellation_reason'),
    );
  });

  it('an already cancelled event keeps its first reason', async () => {
    const { communityId, organizerId } = await createPack();
    const session = await createTraining(organizerId, communityId);
    await cancelTraining(organizerId, session.id, 'First');
    await cancelTraining(organizerId, session.id, 'Second');
    expect(await reasonOf(session.id)).toBe('First');
  });

  it('members, outsiders, other organizers, removed organizers and anon are refused; nothing is written', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const other = await createPack();
    const outsider = await addMember(other.communityId);
    const removed = await addMember(communityId, { role: 'organizer', status: 'removed' });
    const session = await createTraining(organizerId, communityId);
    for (const userId of [memberIds[0], outsider, other.organizerId, removed]) {
      await expect(cancelTraining(userId, session.id, 'Hijacked')).rejects.toMatchObject(raised('forbidden'));
    }
    await expect(
      asAnon((db) => db.query('select public.cancel_training($1, $2)', [session.id, 'Hijacked'])),
    ).rejects.toBeTruthy();
    const row = (await getSession(session.id)) as unknown as WithReason;
    expect(row.status).not.toBe('cancelled');
    expect(row.cancellation_reason).toBeNull();
  });

  it('is executable by authenticated only (the one-argument form no longer exists)', async () => {
    const { rows } = await admin.query<{ sig: string; auth: boolean; anon: boolean; svc: boolean }>(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'cancel_training'`,
    );
    expect(rows).toEqual([{ sig: 'cancel_training(uuid,text)', auth: true, anon: false, svc: false }]);
  });
});

describe('auto-cancel for lack of attendance', () => {
  it('stores the pre-filled reason with going and minimum', async () => {
    const { communityId, organizerId, memberIds } = await createPack(2);
    const short = await createTraining(organizerId, communityId, { min_participants: 3 });
    const ok = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], short.id, 'going');
    await setRsvp(memberIds[1], short.id, 'going');
    await setRsvp(memberIds[0], ok.id, 'going');
    await makeDue(short.id);
    await makeDue(ok.id);
    await finalize();
    const s = (await getSession(short.id)) as unknown as WithReason;
    expect(s).toMatchObject({ status: 'cancelled', cancellation_reason: 'Not enough participants: 2 of 3 needed.' });
    expect(await reasonOf(ok.id)).toBeNull();
    const [n] = await notifications("kind = 'training_cancelled' and related_session_id = $1", [short.id]);
    expect(n.body).toMatch(/ - Not enough participants: 2 of 3 needed\.$/);
  });
});

describe('notification body', () => {
  it('includes the organizer reason; a long reason is cut and the body stays within 500', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const a = await createTraining(organizerId, communityId, { title: 'A' });
    await cancelTraining(organizerId, a.id, 'Pitch is flooded.');
    const [na] = await notifications("kind = 'training_cancelled' and related_session_id = $1", [a.id]);
    expect(na.user_id).toBe(memberIds[0]);
    expect(na.body).toMatch(/ - cancelled by the organizer\. Reason: Pitch is flooded\.$/);

    const b = await createTraining(organizerId, communityId, {
      title: 'B',
      location_name: 'L'.repeat(120),
    });
    await cancelTraining(organizerId, b.id, 'w '.repeat(150).trim());
    const [nb] = await notifications("kind = 'training_cancelled' and related_session_id = $1", [b.id]);
    expect(nb.body.length).toBeLessThanOrEqual(500);
    expect(nb.body).toContain('Reason: w w');
  });

  it('without a reason the text is unchanged', async () => {
    const { communityId, organizerId } = await createPack(1);
    const s = await createTraining(organizerId, communityId);
    await cancelTraining(organizerId, s.id);
    const [n] = await notifications("kind = 'training_cancelled' and related_session_id = $1", [s.id]);
    expect(n.body).toMatch(/ - cancelled by the organizer\.$/);
  });
});

describe('reason only on a cancelled event (table check)', () => {
  it('rejects a reason on a scheduled event and an empty / oversized one', async () => {
    const { communityId, organizerId } = await createPack();
    const s = await createTraining(organizerId, communityId);
    await expect(
      admin.query("update public.training_sessions set cancellation_reason = 'x' where id = $1", [s.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await cancelTraining(organizerId, s.id);
    await expect(
      admin.query("update public.training_sessions set cancellation_reason = '' where id = $1", [s.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      admin.query('update public.training_sessions set cancellation_reason = $2 where id = $1', [s.id, 'y'.repeat(301)]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('a confirmed event has no reason', async () => {
    const { communityId, organizerId, memberIds } = await createPack(1);
    const s = await createTraining(organizerId, communityId, { min_participants: 1 });
    await setRsvp(memberIds[0], s.id, 'going');
    await makeDue(s.id);
    await finalize();
    expect(await reasonOf(s.id)).toBeNull();
  });
});
