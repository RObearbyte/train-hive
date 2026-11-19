/**
 * The one-time "Your account was deleted." notice for the welcome screen.
 * In memory only: it is gone after a reload, by design.
 */
let notice: string | null = null;

export function setAccountDeletedNotice(message: string | null): void {
  notice = message;
}

export function peekAccountDeletedNotice(): string | null {
  return notice;
}
