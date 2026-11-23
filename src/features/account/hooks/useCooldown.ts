import { useCallback, useEffect, useState } from 'react';

import { RESEND_COOLDOWN_SECONDS, tickCooldown } from '../domain/emailLinking';

/**
 * Seconds left before "Send again" works. A plain countdown (not the device
 * clock): it only keeps people from tapping in vain, the server rate-limits.
 */
export function useCooldown() {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return undefined;
    const timer = setInterval(() => setRemaining(tickCooldown), 1000);
    return () => clearInterval(timer);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps -- restart only when the countdown starts or ends

  const start = useCallback(() => setRemaining(RESEND_COOLDOWN_SECONDS), []);
  return { remaining, start };
}
