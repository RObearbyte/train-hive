import { useEffect, useRef, useState } from 'react';

import { removalNotice, type CommunitySnapshot } from '../domain/removalNotice';
import { useCurrentMembership } from './useCurrentMembership';

/**
 * A short notice when the user was removed from the community they were
 * looking at and the app moved them to another one. Mount on a screen that is
 * always present (Home); `dismiss` clears it.
 */
export function useRemovalNotice(): { message: string | null; dismiss: () => void } {
  const { communities, activeCommunityId } = useCurrentMembership();
  const previous = useRef<CommunitySnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // An empty list is "not loaded or nothing left", never a change worth remembering.
    if (communities.length === 0) return;
    const next: CommunitySnapshot = { activeId: activeCommunityId, communities };
    const text = previous.current ? removalNotice(previous.current, next) : null;
    if (text !== null) setMessage(text);
    previous.current = next;
  }, [communities, activeCommunityId]);

  return { message, dismiss: () => setMessage(null) };
}
