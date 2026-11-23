/** The six main sections, shared by the sidebar and for the page titles. Pure. */
import type { IconName } from '@/ui';

export type NavKey = 'home' | 'trainings' | 'communications' | 'statistics' | 'community' | 'profile';

/** `tabLabel`: shorter text for the bottom tab bar when the full label does not fit six tabs on a 360dp phone. */
export type NavItem = { key: NavKey; label: string; tabLabel?: string; href: string; icon: IconName };

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home', href: '/', icon: 'home' },
  { key: 'trainings', label: 'Events', href: '/trainings', icon: 'calendar' },
  { key: 'communications', label: 'Communications', tabLabel: 'Comms', href: '/communications', icon: 'bell' },
  { key: 'statistics', label: 'Statistics', href: '/statistics', icon: 'chart' },
  { key: 'community', label: 'Community', href: '/community', icon: 'people' },
  { key: 'profile', label: 'Profile', href: '/profile', icon: 'person' },
];

/** Which section a path belongs to (detail and settings screens belong to the section that opens them). */
export function activeNavKey(pathname: string): NavKey | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '' || path === '/') return 'home';
  const first = path.split('/')[1];
  switch (first) {
    case 'trainings':
      return 'trainings';
    // Announcements and the notification centre belong to the Communications tab.
    case 'communications':
    case 'activity':
    case 'notifications':
    case 'announcements':
      return 'communications';
    case 'statistics':
      return 'statistics';
    // The member list, the organizer management screens and joining another community open from the Community tab.
    case 'community':
    case 'members':
    case 'invitations':
    case 'community-settings':
    case 'add-community':
      return 'community';
    case 'profile':
    case 'privacy':
    case 'attendance-history':
      return 'profile';
    default:
      return null;
  }
}
