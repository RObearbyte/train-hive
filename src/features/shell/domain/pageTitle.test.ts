import { describe, expect, it } from 'vitest';

import { titleForPath } from './pageTitle';

describe('titleForPath', () => {
  it.each([
    ['/', 'Home · TrainHive'],
    ['/trainings', 'Events · TrainHive'],
    ['/trainings/', 'Events · TrainHive'],
    ['/trainings/new', 'New event · TrainHive'],
    ['/trainings/abc-123', 'Event · TrainHive'],
    ['/trainings/abc-123/edit', 'Edit event · TrainHive'],
    ['/trainings/abc-123/attendance', 'Attendance · TrainHive'],
    ['/communications', 'Communications · TrainHive'],
    ['/activity', 'Notifications · TrainHive'],
    ['/notifications', 'Notifications · TrainHive'],
    ['/announcements', 'Announcements · TrainHive'],
    ['/announcements/9', 'Announcement · TrainHive'],
    ['/statistics', 'Statistics · TrainHive'],
    ['/statistics/u1', 'Member statistics · TrainHive'],
    ['/profile', 'Profile · TrainHive'],
    ['/community', 'Community · TrainHive'],
    ['/invitations', 'Invitations · TrainHive'],
    ['/community-settings', 'Community settings · TrainHive'],
    ['/welcome', 'Welcome · TrainHive'],
    ['/code', 'Join a community · TrainHive'],
    ['/add-community/join-code', 'Join a community · TrainHive'],
    ['/join', 'Join a community · TrainHive'],
    ['/privacy', 'Privacy · TrainHive'],
    ['/members', 'Members · TrainHive'],
    ['/consent', 'Before you start · TrainHive'],
    ['/legal/privacy', 'Privacy Notice · TrainHive'],
    ['/legal/terms', 'Terms of Use · TrainHive'],
  ])('%s -> %s', (path, title) => {
    expect(titleForPath(path)).toBe(title);
  });

  it('unknown paths fall back to the app name, never to the raw path', () => {
    expect(titleForPath('/does/not/exist')).toBe('TrainHive');
    expect(titleForPath('/trainings/<script>/x/y')).toBe('TrainHive');
  });
});
