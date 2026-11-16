import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { reportError } from '@/lib/logger';

import { readActiveCommunityId, writeActiveCommunityId } from '../api/activeCommunityStorage';
import { parseStoredCommunityId } from '../domain/activeCommunity';
import { useSession } from './SessionProvider';

type ActiveCommunityContextValue = {
  /** The stored choice; it may no longer be an active membership (resolve it against the list). */
  storedId: string | null;
  /** The stored choice has been read for the current user. */
  loaded: boolean;
  select: (communityId: string) => void;
};

const ActiveCommunityContext = createContext<ActiveCommunityContextValue | null>(null);

type Stored = { userId: string; id: string | null };

/**
 * Remembers which community the user last picked, per user, in the same
 * secure storage as the session. Reads it once per user; `select` updates the
 * app immediately and saves in the background (a failed save is reported and
 * only means the choice is forgotten after a restart).
 */
export function ActiveCommunityProvider({ children }: { children: ReactNode }) {
  const { userId } = useSession();
  const [stored, setStored] = useState<Stored | null>(null);

  useEffect(() => {
    if (userId === null) return;
    let active = true;
    readActiveCommunityId(userId)
      .then((id) => {
        // A choice made while the read was running wins over the stored one.
        if (active) setStored((current) => (current?.userId === userId ? current : { userId, id }));
      })
      .catch((error: unknown) => {
        reportError('activeCommunity.read', error);
        if (active) setStored((current) => (current?.userId === userId ? current : { userId, id: null }));
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const select = useCallback(
    (communityId: string) => {
      if (userId === null) return;
      const id = parseStoredCommunityId(communityId);
      if (id === null) return;
      setStored({ userId, id });
      writeActiveCommunityId(userId, id).catch((error: unknown) =>
        reportError('activeCommunity.write', error),
      );
    },
    [userId],
  );

  const forThisUser = stored !== null && stored.userId === userId;
  const value: ActiveCommunityContextValue = {
    storedId: forThisUser ? stored.id : null,
    loaded: userId === null || forThisUser,
    select,
  };

  return <ActiveCommunityContext value={value}>{children}</ActiveCommunityContext>;
}

export function useActiveCommunityStore(): ActiveCommunityContextValue {
  const context = use(ActiveCommunityContext);
  if (!context) throw new Error('useActiveCommunityStore must be used inside ActiveCommunityProvider.');
  return context;
}
