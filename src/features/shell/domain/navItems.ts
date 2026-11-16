/** The five main sections, shared by the sidebar and for the page titles. Pure. */
import type { IconName } from '@/ui';

export type NavKey = 'home' | 'trainings' | 'activity' | 'statistics' | 'profile';

export type NavItem = { key: NavKey; label: string; href: string; icon: IconName };

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home', href: '/', icon: 'home' },
  { key: 'trainings', label: 'Trainings', href: '/trainings', icon: 'calendar' },
  { key: 'activity', label: 'Activity', href: '/activity', icon: 'bell' },
  { key: 'statistics', label: 'Statistics', href: '/statistics', icon: 'chart' },
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
    case 'activity':
    case 'announcements':
      return 'activity';
    case 'statistics':
      return 'statistics';
    case 'profile':
    case 'invitations':
    case 'community-settings':
    case 'attendance-history':
    case 'add-community':
      return 'profile';
    default:
      return null;
  }
}
