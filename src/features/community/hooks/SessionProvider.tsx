import type { Session } from '@supabase/supabase-js';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import { reportError } from '@/lib/logger';
import { getSupabase, hasStoredSession } from '@/lib/supabase';

import type { SessionState } from '../domain/gate';

type SessionContextValue = {
  state: SessionState;
  session: Session | null;
  userId: string | null;
};

const SessionContext = createContext<SessionContextValue | null>(null);

type Internal = { state: SessionState; session: Session | null };

/**
 * Restores the stored session on start and follows auth changes. It never
 * signs in by itself: an anonymous account is created only when the user
 * submits an invitation code (`ensureSession`).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Internal>({ state: 'loading', session: null });

  useEffect(() => {
    let active = true;

    // Fires INITIAL_SESSION once storage has been read, then every later change.
    let latestEvent = 0;
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      latestEvent += 1;
      const thisEvent = latestEvent;
      if (session) {
        setValue({ state: 'present', session });
        return;
      }
      // "No session" can also mean "stored, but the expired token could not be
      // refreshed because the device is offline". Tell the two apart so an
      // existing member is not shown onboarding. Deferred: the auth callback
      // must not await other auth / storage work.
      setTimeout(() => {
        hasStoredSession()
          .then((stored) => {
            // A newer auth event (for example a sign-in) wins over this lookup.
            if (!active || thisEvent !== latestEvent) return;
            setValue({ state: stored ? 'unavailable' : 'none', session: null });
          })
          .catch((error: unknown) => {
            reportError('session.restore', error);
            if (active && thisEvent === latestEvent) setValue({ state: 'none', session: null });
          });
      }, 0);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return (
    <SessionContext
      value={{ state: value.state, session: value.session, userId: value.session?.user.id ?? null }}
    >
      {children}
    </SessionContext>
  );
}

export function useSession(): SessionContextValue {
  const context = use(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider.');
  return context;
}
