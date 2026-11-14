import { useState } from 'react';

import { userMessage } from '@/lib/errors';
import { reportError } from '@/lib/logger';

import { retryRestoreSession } from '../api/session';
import { decideRoute, type AppRoute } from '../domain/gate';
import { useSession } from './SessionProvider';
import { useCurrentMembership } from './useCurrentMembership';

export type AppGate = {
  route: AppRoute;
  /** Friendly text for the `error` route. */
  errorMessage: string;
  retry: () => void;
};

/** Which part of the app to show; see `decideRoute` for the rules. */
export function useAppGate(): AppGate {
  const session = useSession();
  const membership = useCurrentMembership();

  // The route depends on the previous one (settled routes are sticky), so it
  // is state adjusted during render rather than a plain derived value.
  const [route, setRoute] = useState<AppRoute>('loading');
  const next = decideRoute({ session: session.state, membership: membership.state }, route);
  if (next !== route) setRoute(next);

  const retry = () => {
    if (session.state === 'unavailable') {
      retryRestoreSession().catch((error: unknown) => reportError('gate.retrySession', error));
    } else {
      membership.refetch().catch((error: unknown) => reportError('gate.retryMembership', error));
    }
  };

  const errorMessage =
    session.state === 'unavailable'
      ? userMessage('network_error')
      : userMessage(membership.error?.code ?? 'unknown', membership.error?.field);

  return { route: next, errorMessage, retry };
}
