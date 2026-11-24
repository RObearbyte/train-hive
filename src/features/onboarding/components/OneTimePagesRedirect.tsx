import { usePathname, useRouter, type Href } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';

import { useAboutYouPrompt } from '@/features/aboutYou/hooks/useAboutYou';
import { useSecurePrompt } from '@/features/account/hooks/useSecurePrompt';
import { useAccountKind } from '@/features/account/hooks/useAccountKind';
import { useCurrentMembership } from '@/features/community/hooks/useCurrentMembership';

import { nextOneTimePage, pathOf, routeOf, seenOf, type OneTimePage } from '../domain/oneTimePages';

/**
 * Wraps the signed-in tabs: the first time (per person, per device) after
 * joining or creating a community it opens the skippable one-time pages on top
 * of whatever was opening (a notification link keeps working underneath):
 * "Secure your account" (anonymous accounts only), then "About you".
 *
 * Each page is remembered as seen on the device as soon as it opens, so the
 * back gesture never brings it back. The next page is only pushed after the
 * previous one was really shown and left (`active`), so nothing loops or
 * stacks. The terms gate sits above this component and shows first.
 */
export function OneTimePagesRedirect({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const account = useAccountKind();
  const membership = useCurrentMembership();
  const secure = useSecurePrompt();
  const aboutYou = useAboutYouPrompt();
  // The page we pushed, and whether it has appeared in the pathname yet.
  const active = useRef<{ page: OneTimePage; entered: boolean } | null>(null);

  const next = nextOneTimePage({
    isAnonymous: account?.kind === 'anonymous',
    secureSeen: seenOf(secure.state),
    aboutYouSeen: seenOf(aboutYou.state),
    hasCommunity: membership.state === 'active',
  });

  useEffect(() => {
    const current = active.current;
    if (current) {
      if (pathname === pathOf(current.page)) current.entered = true;
      if (!current.entered || pathname === pathOf(current.page)) return;
      active.current = null;
    }
    if (next !== 'secure-account' && next !== 'about-you') return;
    active.current = { page: next, entered: false };
    router.push(routeOf(next) as Href);
    // Seen when first shown, not only on Skip / Save.
    void (next === 'secure-account' ? secure.markSeen() : aboutYou.markSeen());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, pathname, router]);

  return <>{children}</>;
}
