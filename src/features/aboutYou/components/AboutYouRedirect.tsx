import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';

import { ABOUT_YOU_WELCOME_ROUTE } from '../domain/prompt';
import { useAboutYouPrompt } from '../hooks/useAboutYou';

/**
 * Wraps the signed-in tabs: the first time (per person, per device) after
 * joining or creating a community it opens the skippable About-you page on top
 * of whatever was opening (a notification link keeps working underneath).
 * It asks once per app start; the page is remembered as seen on the device as soon as it opens.
 */
export function AboutYouRedirect({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { state, markSeen } = useAboutYouPrompt();
  const opened = useRef(false);

  useEffect(() => {
    if (state !== 'show' || opened.current) return;
    opened.current = true;
    router.push(ABOUT_YOU_WELCOME_ROUTE as Href);
    // Seen when first shown, not only on Save / Skip: the back gesture must not bring the page back at every start.
    void markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, router]);

  return <>{children}</>;
}
