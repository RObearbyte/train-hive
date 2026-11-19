/**
 * Text of the blocking "We updated our terms" screen for the rights that do
 * not depend on accepting. Pure: the screen only renders it. Both server
 * functions (`export_my_data`, `delete_my_account`) work without current
 * consent, so these paths are always open.
 */
export const LEAVE_WITHOUT_ACCEPTING_TITLE = 'Prefer not to accept?';

export const LEAVE_WITHOUT_ACCEPTING_TEXT =
  'You do not have to accept to leave. You can download a copy of your data or delete your account right here, without accepting the new terms.';

export const DOWNLOAD_WITHOUT_ACCEPTING_LABEL = 'Download my data';
export const DELETE_WITHOUT_ACCEPTING_LABEL = 'Delete my account';

/** Shown in the delete flow when a community still needs a new organizer: the Members screen is behind the gate. */
export const BLOCKED_BEHIND_GATE_ADVICE =
  'To hand over a community, accept the updated terms first, then use Profile, Members. You can then come back and delete your account.';

/** The actions this screen offers, in order. */
export function termsUpdateActions(): readonly ('accept' | 'download' | 'delete')[] {
  return ['accept', 'download', 'delete'];
}
