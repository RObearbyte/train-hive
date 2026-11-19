/** The notification bell's badge and spoken label. Display only; the server counts what is unread. */

/** "3", "9+" (above 9); null hides the badge. */
export function bellBadgeText(count: number): string | null {
  if (!Number.isFinite(count)) return null;
  const whole = Math.floor(count);
  if (whole <= 0) return null;
  return whole > 9 ? '9+' : String(whole);
}

/** "Notifications, 12 unread" (the real number); plain "Notifications" when nothing is unread. */
export function bellAccessibilityLabel(count: number): string {
  if (!Number.isFinite(count) || Math.floor(count) <= 0) return 'Notifications';
  return `Notifications, ${Math.floor(count)} unread`;
}
