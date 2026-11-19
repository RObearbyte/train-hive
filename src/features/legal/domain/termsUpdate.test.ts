import { describe, expect, it } from 'vitest';

import {
  BLOCKED_BEHIND_GATE_ADVICE,
  LEAVE_WITHOUT_ACCEPTING_TEXT,
  termsUpdateActions,
} from './termsUpdate';

describe('terms update screen view model', () => {
  it('offers export and deletion besides accepting', () => {
    expect(termsUpdateActions()).toEqual(['accept', 'download', 'delete']);
  });

  it('tells the person plainly that leaving does not require accepting', () => {
    expect(LEAVE_WITHOUT_ACCEPTING_TEXT).toMatch(/do not have to accept/);
    expect(LEAVE_WITHOUT_ACCEPTING_TEXT).toMatch(/download/);
    expect(LEAVE_WITHOUT_ACCEPTING_TEXT).toMatch(/delete your account/);
  });

  it('explains the hand-over path when deletion is blocked and Members is behind the gate', () => {
    expect(BLOCKED_BEHIND_GATE_ADVICE).toMatch(/accept the updated terms first/);
    expect(BLOCKED_BEHIND_GATE_ADVICE).toMatch(/Members/);
  });
});
