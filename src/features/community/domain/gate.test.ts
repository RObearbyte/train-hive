import { describe, expect, it } from 'vitest';

import {
  decideRoute,
  type AppRoute,
  type GateInput,
  type MembershipState,
  type SessionState,
} from '@/features/community/domain/gate';

const SESSIONS: SessionState[] = ['loading', 'none', 'unavailable', 'present'];
const MEMBERSHIPS: MembershipState[] = ['pending', 'error', 'none', 'active'];
const ROUTES: AppRoute[] = ['loading', 'error', 'onboarding', 'app'];

/** Feeds a sequence of states through the gate, like the app does over time. */
function run(steps: GateInput[], start: AppRoute = 'loading'): AppRoute[] {
  const routes: AppRoute[] = [];
  let route = start;
  for (const step of steps) {
    route = decideRoute(step, route);
    routes.push(route);
  }
  return routes;
}

describe('decideRoute: cold start', () => {
  it('holds the splash while the session is being restored', () => {
    for (const membership of MEMBERSHIPS) {
      expect(decideRoute({ session: 'loading', membership }, 'loading')).toBe('loading');
    }
  });

  it('sends a device with no account to onboarding', () => {
    for (const membership of MEMBERSHIPS) {
      expect(decideRoute({ session: 'none', membership }, 'loading')).toBe('onboarding');
    }
  });

  it('returning member: straight into the app with no onboarding in between', () => {
    expect(
      run([
        { session: 'loading', membership: 'pending' },
        { session: 'present', membership: 'pending' },
        { session: 'present', membership: 'active' },
      ]),
    ).toEqual(['loading', 'loading', 'app']);
  });

  it('signed in without a membership (never finished joining, or removed): onboarding', () => {
    expect(
      run([
        { session: 'loading', membership: 'pending' },
        { session: 'present', membership: 'pending' },
        { session: 'present', membership: 'none' },
      ]),
    ).toEqual(['loading', 'loading', 'onboarding']);
  });

  it('offline at start with a stored account: an error with retry, never onboarding', () => {
    expect(decideRoute({ session: 'unavailable', membership: 'pending' }, 'loading')).toBe('error');
    expect(decideRoute({ session: 'present', membership: 'error' }, 'loading')).toBe('error');
  });

  it('recovers from the error screen once the answer arrives', () => {
    expect(
      run([
        { session: 'present', membership: 'error' },
        { session: 'present', membership: 'pending' },
        { session: 'present', membership: 'active' },
      ]),
    ).toEqual(['error', 'loading', 'app']);
    expect(
      run([
        { session: 'unavailable', membership: 'pending' },
        { session: 'present', membership: 'pending' },
        { session: 'present', membership: 'none' },
      ]),
    ).toEqual(['error', 'loading', 'onboarding']);
  });
});

describe('decideRoute: during onboarding', () => {
  it('stays in onboarding through the lazy anonymous sign-in and the lookups that follow', () => {
    expect(
      run(
        [
          { session: 'present', membership: 'pending' }, // signed in when the code was submitted
          { session: 'present', membership: 'none' },
          { session: 'present', membership: 'pending' }, // refetch after redeeming
          { session: 'present', membership: 'active' },
        ],
        'onboarding',
      ),
    ).toEqual(['onboarding', 'onboarding', 'onboarding', 'app']);
  });

  it('a returning member who signs in with an email goes straight to the app, never through joining again', () => {
    expect(
      run(
        [
          { session: 'none', membership: 'pending' }, // welcome screen, signed out
          { session: 'present', membership: 'pending' }, // code accepted: the session arrives, communities load
          { session: 'present', membership: 'active' },
        ],
        'onboarding',
      ),
    ).toEqual(['onboarding', 'onboarding', 'app']);
  });

  it('a signed-in account without any community stays in onboarding (the sign-in screen sends it to the welcome screen)', () => {
    expect(decideRoute({ session: 'present', membership: 'none' }, 'onboarding')).toBe('onboarding');
  });

  it('stays in onboarding when a lookup fails', () => {
    expect(decideRoute({ session: 'present', membership: 'error' }, 'onboarding')).toBe(
      'onboarding',
    );
    expect(decideRoute({ session: 'unavailable', membership: 'pending' }, 'onboarding')).toBe(
      'onboarding',
    );
  });
});

describe('decideRoute: inside the app', () => {
  it('stays in the app through refetches and failures', () => {
    expect(
      run(
        [
          { session: 'present', membership: 'pending' },
          { session: 'present', membership: 'error' },
          { session: 'unavailable', membership: 'error' },
          { session: 'present', membership: 'active' },
        ],
        'app',
      ),
    ).toEqual(['app', 'app', 'app', 'app']);
  });

  it('moves a removed member to onboarding', () => {
    expect(decideRoute({ session: 'present', membership: 'none' }, 'app')).toBe('onboarding');
  });

  it('moves to onboarding when the account is gone from the device', () => {
    for (const membership of MEMBERSHIPS) {
      expect(decideRoute({ session: 'none', membership }, 'app')).toBe('onboarding');
    }
  });
});

describe('decideRoute: invariants', () => {
  it('only enters the app with a session and an active membership', () => {
    for (const session of SESSIONS) {
      for (const membership of MEMBERSHIPS) {
        for (const previous of ROUTES) {
          const route = decideRoute({ session, membership }, previous);
          const definite = session === 'present' && membership === 'active';
          if (route === 'app' && previous !== 'app') expect(definite).toBe(true);
          if (definite) expect(route).toBe('app');
        }
      }
    }
  });

  it('never shows onboarding from a cold start unless the answer is definite', () => {
    for (const session of SESSIONS) {
      for (const membership of MEMBERSHIPS) {
        for (const previous of ['loading', 'error'] as const) {
          const route = decideRoute({ session, membership }, previous);
          const definite = session === 'none' || (session === 'present' && membership === 'none');
          expect(route === 'onboarding').toBe(definite);
        }
      }
    }
  });

  it('never goes back to loading or error once settled', () => {
    for (const session of SESSIONS) {
      for (const membership of MEMBERSHIPS) {
        for (const previous of ['onboarding', 'app'] as const) {
          expect(['onboarding', 'app']).toContain(decideRoute({ session, membership }, previous));
        }
      }
    }
  });

  it('is stable: applying the same input twice changes nothing', () => {
    for (const session of SESSIONS) {
      for (const membership of MEMBERSHIPS) {
        for (const previous of ROUTES) {
          const once = decideRoute({ session, membership }, previous);
          expect(decideRoute({ session, membership }, once)).toBe(once);
        }
      }
    }
  });
});
