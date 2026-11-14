import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHUNK_SIZE,
  createChunkedStorage,
  splitIntoChunks,
  type KeyValueBackend,
} from '@/lib/chunkedStorage';

/** In-memory backend that enforces a per-value size limit like the keychain does. */
function createFakeBackend(maxValueLength = Number.POSITIVE_INFINITY) {
  const data = new Map<string, string>();
  let failOnWrite: ((key: string) => boolean) | null = null;
  const backend: KeyValueBackend = {
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (failOnWrite?.(key)) throw new Error(`simulated crash writing ${key}`);
      if (value.length > maxValueLength) throw new Error(`value too large for ${key}`);
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  return {
    backend,
    data,
    failWritesWhen(predicate: ((key: string) => boolean) | null) {
      failOnWrite = predicate;
    },
  };
}

const KEY = 'sb-project-auth-token';

describe('splitIntoChunks', () => {
  it('splits into pieces of at most the given size that join back', () => {
    const value = 'abcdefghij';
    expect(splitIntoChunks(value, 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(splitIntoChunks(value, 10)).toEqual([value]);
    expect(splitIntoChunks(value, 100)).toEqual([value]);
    expect(splitIntoChunks('', 4)).toEqual([]);
  });

  it('never cuts a surrogate pair in half', () => {
    const value = 'ab😀cd😀😀e';
    for (let size = 2; size <= 6; size += 1) {
      const chunks = splitIntoChunks(value, size);
      expect(chunks.join('')).toBe(value);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(size);
        expect(chunk.length).toBeGreaterThan(0);
        // A well-formed string survives a UTF-8 round trip unchanged.
        expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(chunk);
      }
    }
  });

  it('rejects a chunk size that cannot hold a surrogate pair', () => {
    expect(() => splitIntoChunks('abc', 1)).toThrow(RangeError);
    expect(() => splitIntoChunks('abc', 0)).toThrow(RangeError);
    expect(() => splitIntoChunks('abc', 2.5)).toThrow(RangeError);
  });
});

describe('createChunkedStorage', () => {
  it('returns null for a key that was never stored', async () => {
    const { backend } = createFakeBackend();
    expect(await createChunkedStorage(backend).getItem(KEY)).toBeNull();
  });

  it('round-trips a value larger than the backend limit', async () => {
    const { backend, data } = createFakeBackend(10);
    const storage = createChunkedStorage(backend, 10);
    const value = JSON.stringify({ access_token: 'x'.repeat(95), refresh_token: 'y'.repeat(20) });

    await storage.setItem(KEY, value);

    expect(await storage.getItem(KEY)).toBe(value);
    expect(data.size).toBeGreaterThan(10);
    for (const stored of data.values()) expect(stored.length).toBeLessThanOrEqual(10);
  });

  it('keeps every chunk under the keychain byte limit with the default size', async () => {
    const { backend, data } = createFakeBackend();
    const storage = createChunkedStorage(backend);
    // Worst case for UTF-8: 3 bytes per UTF-16 unit.
    const value = 'Ț'.repeat(1000) + '€'.repeat(3000) + '😀'.repeat(500);

    await storage.setItem(KEY, value);

    expect(await storage.getItem(KEY)).toBe(value);
    expect(DEFAULT_CHUNK_SIZE * 3).toBeLessThan(2048);
    for (const stored of data.values()) {
      expect(new TextEncoder().encode(stored).length).toBeLessThan(2048);
    }
  });

  it('round-trips small, empty and non-ASCII values', async () => {
    const { backend } = createFakeBackend();
    const storage = createChunkedStorage(backend, 4);
    for (const value of ['a', '', 'Ștefan 😀 Țăranu', '{"a":1}']) {
      await storage.setItem(KEY, value);
      expect(await storage.getItem(KEY)).toBe(value);
    }
  });

  it('uses only key characters SecureStore allows', async () => {
    const { backend, data } = createFakeBackend();
    await createChunkedStorage(backend, 4).setItem(KEY, 'x'.repeat(30));
    for (const key of data.keys()) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('overwrites with a shorter value and leaves no old chunks behind', async () => {
    const { backend, data } = createFakeBackend();
    const storage = createChunkedStorage(backend, 4);

    await storage.setItem(KEY, 'x'.repeat(40));
    await storage.setItem(KEY, 'short');

    expect(await storage.getItem(KEY)).toBe('short');
    // meta + 2 chunks
    expect(data.size).toBe(3);
  });

  it('survives many overwrites without leaking keys', async () => {
    const { backend, data } = createFakeBackend();
    const storage = createChunkedStorage(backend, 4);
    for (let round = 1; round <= 12; round += 1) {
      const value = `${round}:`.padEnd((round % 5) * 7 + 3, 'z');
      await storage.setItem(KEY, value);
      expect(await storage.getItem(KEY)).toBe(value);
      expect(data.size).toBe(1 + Math.ceil(value.length / 4));
    }
  });

  it('removes the value and every chunk', async () => {
    const { backend, data } = createFakeBackend();
    const storage = createChunkedStorage(backend, 4);
    await storage.setItem(KEY, 'x'.repeat(40));

    await storage.removeItem(KEY);

    expect(await storage.getItem(KEY)).toBeNull();
    expect(data.size).toBe(0);
  });

  it('removing a missing key is a no-op', async () => {
    const { backend, data } = createFakeBackend();
    await createChunkedStorage(backend).removeItem(KEY);
    expect(data.size).toBe(0);
  });

  it('keeps keys independent, including keys that share a prefix', async () => {
    const { backend } = createFakeBackend();
    const storage = createChunkedStorage(backend, 4);

    await storage.setItem(KEY, 'session-value');
    await storage.setItem(`${KEY}-code-verifier`, 'verifier-value');
    await storage.setItem(`${KEY}-user`, 'user-value');
    await storage.removeItem(`${KEY}-user`);

    expect(await storage.getItem(KEY)).toBe('session-value');
    expect(await storage.getItem(`${KEY}-code-verifier`)).toBe('verifier-value');
    expect(await storage.getItem(`${KEY}-user`)).toBeNull();
  });

  describe('crash safety', () => {
    it('keeps the previous value when a write fails part-way through the chunks', async () => {
      const fake = createFakeBackend();
      const storage = createChunkedStorage(fake.backend, 4);
      await storage.setItem(KEY, 'the-good-session');

      // Fail on the third chunk of the next write.
      fake.failWritesWhen((key) => key.endsWith('.2'));
      await expect(storage.setItem(KEY, 'a-new-session-that-never-lands')).rejects.toThrow(
        'simulated crash',
      );
      fake.failWritesWhen(null);

      expect(await storage.getItem(KEY)).toBe('the-good-session');
    });

    it('keeps the previous value when the final flip fails', async () => {
      const fake = createFakeBackend();
      const storage = createChunkedStorage(fake.backend, 4);
      await storage.setItem(KEY, 'the-good-session');

      fake.failWritesWhen((key) => key.endsWith('.meta'));
      await expect(storage.setItem(KEY, 'another-session')).rejects.toThrow('simulated crash');
      fake.failWritesWhen(null);

      expect(await storage.getItem(KEY)).toBe('the-good-session');
    });

    it('recovers on the next write after a failed one', async () => {
      const fake = createFakeBackend();
      const storage = createChunkedStorage(fake.backend, 4);
      await storage.setItem(KEY, 'first');
      fake.failWritesWhen((key) => key.endsWith('.1'));
      await expect(storage.setItem(KEY, 'second-value')).rejects.toThrow();
      fake.failWritesWhen(null);

      await storage.setItem(KEY, 'third-value');

      expect(await storage.getItem(KEY)).toBe('third-value');
      expect(fake.data.size).toBe(1 + Math.ceil('third-value'.length / 4));
    });

    it('reports nothing stored when a chunk is missing, instead of a truncated value', async () => {
      const fake = createFakeBackend();
      const storage = createChunkedStorage(fake.backend, 4);
      await storage.setItem(KEY, 'x'.repeat(20));

      fake.data.delete(`${KEY}.a.2`);

      expect(await storage.getItem(KEY)).toBeNull();
    });

    it('treats a corrupt meta entry as nothing stored', async () => {
      const fake = createFakeBackend();
      fake.data.set(`${KEY}.meta`, 'garbage');
      const storage = createChunkedStorage(fake.backend, 4);

      expect(await storage.getItem(KEY)).toBeNull();
      await storage.setItem(KEY, 'fresh');
      expect(await storage.getItem(KEY)).toBe('fresh');
    });
  });

  it('serializes concurrent operations so reads never see a partial write', async () => {
    // A backend that yields between every operation.
    const { backend } = createFakeBackend();
    const slow: KeyValueBackend = {
      getItem: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return backend.getItem(key);
      },
      setItem: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return backend.setItem(key, value);
      },
      removeItem: (key) => backend.removeItem(key),
    };
    const storage = createChunkedStorage(slow, 4);
    const first = 'a'.repeat(30);
    const second = 'b'.repeat(18);

    const results = await Promise.all([
      storage.setItem(KEY, first),
      storage.getItem(KEY),
      storage.setItem(KEY, second),
      storage.getItem(KEY),
    ]);

    expect(results[1]).toBe(first);
    expect(results[3]).toBe(second);
  });

  it('keeps working after a failed operation', async () => {
    const fake = createFakeBackend();
    const storage = createChunkedStorage(fake.backend, 4);
    fake.failWritesWhen(() => true);
    await expect(storage.setItem(KEY, 'value')).rejects.toThrow();
    fake.failWritesWhen(null);

    await storage.setItem(KEY, 'value');
    expect(await storage.getItem(KEY)).toBe('value');
  });
});
