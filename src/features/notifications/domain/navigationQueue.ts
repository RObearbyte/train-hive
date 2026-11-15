/**
 * Holds a notification tap until the app is ready to navigate, then runs it
 * exactly once. A cold start from a notification delivers the tap before the
 * membership gate has resolved; navigating then would be lost or land on the
 * wrong screen. Repeats of an already handled notification are ignored.
 */

const MAX_REMEMBERED = 200;

export type NavigationQueue = {
  /** Offer a tap. Returns false when it is a repeat of one already handled. */
  offer: (target: { id: string | null; href: string }) => boolean;
  /** Tell the queue whether navigation is possible; flushes a waiting tap when it becomes true. */
  setReady: (ready: boolean) => void;
};

export function createNavigationQueue(navigate: (href: string) => void): NavigationQueue {
  const handled = new Set<string>();
  let pending: string | null = null;
  let ready = false;

  const remember = (id: string) => {
    handled.add(id);
    if (handled.size > MAX_REMEMBERED) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }
  };

  return {
    offer({ id, href }) {
      if (id !== null) {
        if (handled.has(id)) return false;
        remember(id);
      }
      if (ready) {
        navigate(href);
      } else {
        // Only the latest tap matters: the user ends up where they tapped last.
        pending = href;
      }
      return true;
    },
    setReady(next) {
      ready = next;
      if (ready && pending !== null) {
        const href = pending;
        pending = null;
        navigate(href);
      }
    },
  };
}
