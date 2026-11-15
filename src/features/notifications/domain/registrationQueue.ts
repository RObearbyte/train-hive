/**
 * "Latest key wins" queue for push registration. One run at a time; a request
 * that arrives while a run is in flight is remembered (only the latest one)
 * and handled when the run settles, instead of being dropped. The key is the
 * identity of what triggered the request (a device token, or a label such as
 * "foreground"); the run itself fetches whatever it needs.
 *
 * Pure TypeScript, no timers: unit tested directly.
 */
export class RegistrationQueue {
  private running = false;
  private pending: string | null = null;

  constructor(private readonly run: (key: string) => Promise<boolean>) {}

  /** Start a run now, or remember `key` as the latest pending request. */
  async submit(key: string): Promise<void> {
    if (this.running) {
      this.pending = key;
      return;
    }
    this.running = true;
    try {
      let current: string | null = key;
      while (current !== null) {
        const ok = await this.run(current);
        const next: string | null = this.pending;
        this.pending = null;
        // A pending request identical to a run that just succeeded adds nothing.
        current = next !== null && (next !== current || !ok) ? next : null;
      }
    } finally {
      this.running = false;
    }
  }
}
