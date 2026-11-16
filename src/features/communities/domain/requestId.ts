/**
 * The idempotency key of `create_community_with_code` (`p_request_id`).
 *
 * One id per form submission, reused when the same submission is retried
 * (network error, double tap, coming back to the screen), so the server
 * answers a replay with the first result instead of creating a second
 * community. Editing the form after an attempt means a new submission and a
 * new id. Kept in memory for the length of the flow: if the app is killed
 * between the request and its answer, the retry gets a new id (the server
 * still limits creation by the code's uses).
 */

export type RequestIdInput = {
  code: string;
  name: string;
  timezone: string;
  displayName: string;
};

export type RequestIdTracker = {
  /** The id for this submission: the same as last time for the same values, else a new one. */
  idFor: (input: RequestIdInput) => string;
  /** Forget the current id (after success), so the next submission starts fresh. */
  reset: () => void;
};

function fingerprint(input: RequestIdInput): string {
  return JSON.stringify([input.code, input.name, input.timezone, input.displayName]);
}

export function createRequestIdTracker(generate: () => string): RequestIdTracker {
  let current: { fingerprint: string; id: string } | null = null;
  return {
    idFor(input) {
      const key = fingerprint(input);
      if (current === null || current.fingerprint !== key) current = { fingerprint: key, id: generate() };
      return current.id;
    },
    reset() {
      current = null;
    },
  };
}
