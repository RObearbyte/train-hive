import { describe, expect, it } from 'vitest';

import { createNavigationQueue } from './navigationQueue';

function setup() {
  const visited: string[] = [];
  const queue = createNavigationQueue((href) => visited.push(href));
  return { visited, queue };
}

describe('createNavigationQueue', () => {
  it('holds a cold-start tap until the app is ready, then navigates once', () => {
    const { visited, queue } = setup();
    expect(queue.offer({ id: 'n1', href: '/activity' })).toBe(true);
    expect(visited).toEqual([]);
    queue.setReady(true);
    expect(visited).toEqual(['/activity']);
    queue.setReady(false);
    queue.setReady(true);
    expect(visited).toEqual(['/activity']);
  });

  it('navigates immediately when already ready', () => {
    const { visited, queue } = setup();
    queue.setReady(true);
    queue.offer({ id: 'n1', href: '/a' });
    expect(visited).toEqual(['/a']);
  });

  it('ignores a repeat of a handled notification, queued or not', () => {
    const { visited, queue } = setup();
    expect(queue.offer({ id: 'n1', href: '/a' })).toBe(true);
    expect(queue.offer({ id: 'n1', href: '/a' })).toBe(false);
    queue.setReady(true);
    expect(queue.offer({ id: 'n1', href: '/a' })).toBe(false);
    expect(visited).toEqual(['/a']);
  });

  it('keeps only the latest tap while waiting', () => {
    const { visited, queue } = setup();
    queue.offer({ id: 'n1', href: '/a' });
    queue.offer({ id: 'n2', href: '/b' });
    queue.setReady(true);
    expect(visited).toEqual(['/b']);
  });

  it('never dedupes taps without an id', () => {
    const { visited, queue } = setup();
    queue.setReady(true);
    queue.offer({ id: null, href: '/a' });
    queue.offer({ id: null, href: '/a' });
    expect(visited).toEqual(['/a', '/a']);
  });
});
