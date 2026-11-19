/**
 * TanStack Query keys for consents.
 * - `consentKeys.mine(userId)` -> `MyConsents` (the server's view)
 * - `consentKeys.local`        -> `LocalAcceptance | null` (this device's first-launch acknowledgement)
 */
export const consentKeys = {
  all: ['consents'] as const,
  mine: (userId: string | null) => ['consents', 'mine', userId] as const,
  local: ['consents', 'local'] as const,
};
