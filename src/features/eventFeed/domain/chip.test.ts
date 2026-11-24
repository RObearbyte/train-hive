import { describe, expect, it } from 'vitest';

import { discussionChip } from './chip';

const row = (post_count: number, unread_count: number) => ({ post_count, unread_count });

describe('discussionChip', () => {
  it('shows nothing without a row or without posts', () => {
    expect(discussionChip(null)).toBeNull();
    expect(discussionChip(row(0, 0))).toBeNull();
  });

  it('is accent with the unread count when something is unread', () => {
    expect(discussionChip(row(5, 3))).toEqual({
      unread: true,
      text: '3 new',
      label: 'Discussion, 3 new messages',
    });
  });

  it('uses the singular for one unread message', () => {
    expect(discussionChip(row(1, 1))?.label).toBe('Discussion, 1 new message');
  });

  it('caps the unread count at 99+', () => {
    expect(discussionChip(row(300, 99))?.text).toBe('99 new');
    expect(discussionChip(row(300, 100))?.text).toBe('99+ new');
  });

  it('is quiet with the post count when nothing is unread', () => {
    expect(discussionChip(row(5, 0))).toEqual({
      unread: false,
      text: '5',
      label: 'Discussion, 5 messages',
    });
    expect(discussionChip(row(1, 0))?.label).toBe('Discussion, 1 message');
    expect(discussionChip(row(150, 0))?.text).toBe('99+');
  });

  it('ignores nonsense numbers', () => {
    expect(discussionChip(row(Number.NaN, Number.NaN))).toBeNull();
    expect(discussionChip(row(-2, -1))).toBeNull();
  });
});
