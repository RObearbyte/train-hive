/**
 * The join / create screens exist twice, once per navigator group, because
 * the root gate shows exactly one group at a time:
 *
 * - `onboarding`: someone with no community yet. Screens live in `(onboarding)`.
 * - `signedIn`: someone who already belongs to a community and is adding
 *   another. Screens live in `(app)/add-community`, so the gate never bounces
 *   them and cancelling returns to the app.
 *
 * The screens are shared; only the routes differ. Pure, and the route files
 * are checked against this table by a test.
 */

export type AddCommunityFlow = 'onboarding' | 'signedIn';

export type FlowRoutes = {
  joinCode: string;
  joinName: string;
  createCode: string;
  createDetails: string;
};

export const FLOW_ROUTES: Record<AddCommunityFlow, FlowRoutes> = {
  onboarding: {
    joinCode: '/code',
    joinName: '/name',
    createCode: '/creator-code',
    createDetails: '/create-community',
  },
  signedIn: {
    joinCode: '/add-community/join-code',
    joinName: '/add-community/join-name',
    createCode: '/add-community/creator-code',
    createDetails: '/add-community/create-community',
  },
};

/** The navigator group folder (under `src/app`) that must contain a flow's screens. */
export const FLOW_GROUP: Record<AddCommunityFlow, '(onboarding)' | '(app)'> = {
  onboarding: '(onboarding)',
  signedIn: '(app)',
};

/**
 * The screen files for a route: `/code` -> `(onboarding)/code.tsx`,
 * `/add-community/join-code` -> `(app)/add-community/join-code.tsx`.
 */
export function routeFileFor(flow: AddCommunityFlow, route: string): string {
  return `${FLOW_GROUP[flow]}${route}.tsx`;
}
