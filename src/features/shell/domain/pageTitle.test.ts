import { describe, expect, it } from 'vitest';

import { titleForPath } from './pageTitle';

describe('titleForPath', () => {
  it.each([
    ['/', 'Home · TrainHive'],
    ['/trainings', 'Trainings · TrainHive'],
    ['/trainings/', 'Trainings · TrainHive'],
    ['/trainings/new', 'New training · TrainHive'],
    ['/trainings/abc-123', 'Training · TrainHive'],
    ['/trainings/abc-123/edit', 'Edit training · TrainHive'],
    ['/trainings/abc-123/attendance', 'Attendance · TrainHive'],
    ['/activity', 'Activity · TrainHive'],
    ['/announcements/9', 'Announcement · TrainHive'],
    ['/statistics', 'Statistics · TrainHive'],
    ['/statistics/u1', 'Member statistics · TrainHive'],
    ['/profile', 'Profile · TrainHive'],
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
