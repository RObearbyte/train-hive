import { describe, expect, it } from 'vitest';

import { RegistrationQueue } from './registrationQueue';

function deferred() {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('RegistrationQueue', () => {
  it('runs a single request once', async () => {
    const calls: string[] = [];
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      return true;
    });
    await queue.submit('a');
    expect(calls).toEqual(['a']);
  });

  it('registers the latest token that changed during a run, dropping the ones in between', async () => {
    const calls: string[] = [];
    const gates = [deferred(), deferred()];
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      return gates[calls.length - 1].promise;
    });
    const first = queue.submit('t1');
    await queue.submit('t2');
    await queue.submit('t3');
    expect(calls).toEqual(['t1']);
    gates[0].resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve(true);
    await first;
    expect(calls).toEqual(['t1', 't3']);
  });

  it('ignores a pending request identical to the run that succeeded', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      return gate.promise;
    });
    const first = queue.submit('t1');
    await queue.submit('t1');
    await queue.submit('t1');
    gate.resolve(true);
    await first;
    expect(calls).toEqual(['t1']);
  });

  it('retries an identical pending request when the run failed', async () => {
    const calls: string[] = [];
    const results = [false, true];
    const gate = deferred();
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      if (calls.length === 1) return gate.promise;
      return results[calls.length - 1];
    });
    const first = queue.submit('t1');
    await queue.submit('t1');
    gate.resolve(false);
    await first;
    expect(calls).toEqual(['t1', 't1']);
  });

  it('does not retry on its own after a failure, and a later request runs again', async () => {
    const calls: string[] = [];
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      return false;
    });
    await queue.submit('t1');
    expect(calls).toEqual(['t1']);
    await queue.submit('t1');
    expect(calls).toEqual(['t1', 't1']);
  });

  it('keeps going after a run when the next pending also changes during the second run', async () => {
    const calls: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const queue = new RegistrationQueue(async (key) => {
      calls.push(key);
      return gates[calls.length - 1].promise;
    });
    const first = queue.submit('t1');
    await queue.submit('t2');
    gates[0].resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['t1', 't2']);
    await queue.submit('t3');
    gates[1].resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    gates[2].resolve(true);
    await first;
    expect(calls).toEqual(['t1', 't2', 't3']);
  });

  it('releases the lock when a run throws', async () => {
    let n = 0;
    const queue = new RegistrationQueue(async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return true;
    });
    await expect(queue.submit('a')).rejects.toThrow('boom');
    await queue.submit('b');
    expect(n).toBe(2);
  });
});
