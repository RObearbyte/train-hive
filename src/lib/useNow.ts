import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * The current time as state, refreshed on an interval and when the app
 * returns to the foreground, so "Today", "Finalizing" and deadline hints do
 * not go stale on an open screen.
 *
 * For display only. The device clock never allows or denies anything: the
 * server enforces deadlines with its own clock.
 */
export function useNow(intervalMs: number = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    const interval = setInterval(tick, intervalMs);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [intervalMs]);

  return now;
}
