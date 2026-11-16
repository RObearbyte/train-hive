import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decideRoute } from '@/features/community/domain/gate';

import { FLOW_GROUP, FLOW_ROUTES, routeFileFor, type AddCommunityFlow } from './flowRoutes';

const APP_DIR = path.resolve(__dirname, '..', '..', '..', 'app');
const FLOWS: AddCommunityFlow[] = ['onboarding', 'signedIn'];

describe('join and create screens exist in the group the gate shows for each kind of user', () => {
  it.each(FLOWS)('every %s route has a screen file in its group', (flow) => {
    for (const route of Object.values(FLOW_ROUTES[flow])) {
      expect(existsSync(path.join(APP_DIR, routeFileFor(flow, route))), routeFileFor(flow, route)).toBe(true);
    }
  });

  it('someone with no membership is shown (onboarding), someone with one is shown (app)', () => {
    expect(decideRoute({ session: 'present', membership: 'none' }, 'loading')).toBe('onboarding');
    expect(decideRoute({ session: 'none', membership: 'pending' }, 'loading')).toBe('onboarding');
    expect(decideRoute({ session: 'present', membership: 'active' }, 'loading')).toBe('app');
    expect(FLOW_GROUP.onboarding).toBe('(onboarding)');
    expect(FLOW_GROUP.signedIn).toBe('(app)');
  });

  it('a user adding a community stays in the app while the new membership loads', () => {
    // After the join / create the membership queries refetch: unknown states never move a settled user.
    expect(decideRoute({ session: 'present', membership: 'pending' }, 'app')).toBe('app');
    expect(decideRoute({ session: 'present', membership: 'error' }, 'app')).toBe('app');
  });

  it('the two flows never share a route, and signed-in routes are outside the onboarding group', () => {
    const onboarding = new Set(Object.values(FLOW_ROUTES.onboarding));
    for (const route of Object.values(FLOW_ROUTES.signedIn)) {
      expect(onboarding.has(route)).toBe(false);
      expect(route.startsWith('/add-community/')).toBe(true);
    }
  });
});
