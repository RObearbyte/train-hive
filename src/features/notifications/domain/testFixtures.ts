import type { Announcement, AppNotification } from '@/lib/database.types';

export function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    community_id: 'c1',
    author_id: 'org',
    title: 'Hello',
    body: 'Body',
    status: 'published',
    scheduled_for: null,
    published_at: '2026-11-10T10:00:00Z',
    cancelled_at: null,
    created_at: '2026-11-10T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z',
    ...overrides,
  };
}

export function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    user_id: 'me',
    community_id: 'c1',
    kind: 'training_created',
    title: 'New training',
    body: 'Body',
    deep_link: '/trainings/x',
    related_session_id: 's1',
    related_announcement_id: null,
    dedupe_key: 'k1',
    created_at: '2026-11-10T10:00:00Z',
    read_at: null,
    ...overrides,
  };
}
