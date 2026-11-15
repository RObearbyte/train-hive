/**
 * Decides which part of the app the user sees. Pure, so the "no flash of
 * onboarding for a returning user" rule is unit tested.
 *
 * This is navigation only. Access is enforced by RLS on the server: a user
 * without an active membership can read nothing whatever screen they reach.
 */

export type AppRoute =
  /** Still finding out; the splash screen stays up. */
  | 'loading'
  /** Could not find out (offline at start). Shown with a retry, never as onboarding. */
  | 'error'
  | 'onboarding'
  | 'app';

export type SessionState =
  /** Storage has not been read yet. */
  | 'loading'
  /** No account on this device. */
  | 'none'
  /** An account is stored but cannot be used right now (expired token, offline). */
  | 'unavailable'
  | 'present';

export type MembershipState =
  /** Not known yet for the current user. */
  | 'pending'
  /** The lookup failed and nothing is cached. */
  | 'error'
  /** Signed in, no active membership (never joined, or removed: they look the same). */
  | 'none'
  | 'active';

export type GateInput = { session: SessionState; membership: MembershipState };

function isSettled(route: AppRoute): route is 'onboarding' | 'app' {
  return route === 'onboarding' || route === 'app';
}

/**
 * `previous` is the route currently shown. Once the user is in onboarding or
 * in the app, an unknown state (a refetch, a failed request, the anonymous
 * sign-in that happens in the middle of onboarding) keeps them where they
 * are; only a definite answer moves them.
 */
export function decideRoute(input: GateInput, previous: AppRoute): AppRoute {
  switch (input.session) {
    case 'loading':
      return isSettled(previous) ? previous : 'loading';
    case 'unavailable':
      return isSettled(previous) ? previous : 'error';
    case 'none':
      return 'onboarding';
    case 'present':
      break;
  }

  switch (input.membership) {
    case 'active':
      return 'app';
    case 'none':
      return 'onboarding';
    case 'pending':
      return isSettled(previous) ? previous : 'loading';
    case 'error':
      return isSettled(previous) ? previous : 'error';
  }
}

/**
 * The gate's view of the membership query. A failed refetch wins over a stale
 * "no membership" (`null`): right after joining, the refetch that should find
 * the new membership can fail while the cache still holds null, and the user
 * must see "joined, try again" rather than a spinner. A failed background
 * refetch of an active membership keeps showing the app.
 */
export function membershipStateOf(query: {
  data: unknown;
  isError: boolean;
}): MembershipState {
  if (query.isError && (query.data === undefined || query.data === null)) return 'error';
  if (query.data !== undefined) return query.data === null ? 'none' : 'active';
  return 'pending';
}
