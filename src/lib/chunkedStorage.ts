/**
 * Splits large values across several keys of a size-limited key-value store.
 *
 * Why: the Supabase session JSON is larger than what the iOS keychain reliably
 * accepts in one expo-secure-store entry (about 2048 bytes).
 *
 * Crash safety: the session is the only proof of an anonymous account, so a
 * half-written value must never replace a good one. Each write goes to the
 * generation that is NOT currently live ("a" / "b"), and only then is the
 * single meta entry flipped to point at it. A crash before the flip leaves the
 * old value intact; a crash after it leaves only unreferenced chunks, which
 * the next write or remove cleans up.
 *
 * Pure TypeScript: the backend is injected, so this is unit tested with an
 * in-memory fake.
 */

export interface KeyValueBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The storage shape supabase-js accepts for `auth.storage`. */
export interface AsyncStringStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * UTF-16 units per chunk. A unit is at most 3 bytes in UTF-8, so 600 units
 * stay under 1800 bytes, below the ~2048 byte keychain limit.
 */
export const DEFAULT_CHUNK_SIZE = 600;

type Generation = 'a' | 'b';
type Meta = { generation: Generation; count: number };

const META_PATTERN = /^([ab]):(\d{1,6})$/;

const metaKey = (key: string) => `${key}.meta`;
const chunkKey = (key: string, generation: Generation, index: number) =>
  `${key}.${generation}.${index}`;

function parseMeta(raw: string | null): Meta | null {
  if (raw === null) return null;
  const match = META_PATTERN.exec(raw);
  if (!match) return null;
  return { generation: match[1] as Generation, count: Number(match[2]) };
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * Splits into pieces of at most `size` UTF-16 units without cutting a
 * surrogate pair in half (a lone surrogate cannot be encoded as UTF-8).
 */
export function splitIntoChunks(value: string, size: number): string[] {
  if (!Number.isInteger(size) || size < 2) throw new RangeError('Chunk size must be at least 2.');
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + size, value.length);
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

export function createChunkedStorage(
  backend: KeyValueBackend,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncStringStorage {
  // Operations run one at a time so a read never sees a write in progress.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  async function removeChunks(key: string, generation: Generation, from: number, to: number) {
    for (let index = from; index < to; index += 1) {
      await backend.removeItem(chunkKey(key, generation, index));
    }
  }

  return {
    getItem: (key) =>
      enqueue(async () => {
        const meta = parseMeta(await backend.getItem(metaKey(key)));
        if (!meta) return null;
        const parts: string[] = [];
        for (let index = 0; index < meta.count; index += 1) {
          const part = await backend.getItem(chunkKey(key, meta.generation, index));
          // A missing chunk means the value is unrecoverable; report "nothing
          // stored" rather than returning a truncated string.
          if (part === null) return null;
          parts.push(part);
        }
        return parts.join('');
      }),

    setItem: (key, value) =>
      enqueue(async () => {
        const previous = parseMeta(await backend.getItem(metaKey(key)));
        const generation: Generation = previous?.generation === 'a' ? 'b' : 'a';
        const chunks = splitIntoChunks(value, chunkSize);

        for (let index = 0; index < chunks.length; index += 1) {
          await backend.setItem(chunkKey(key, generation, index), chunks[index]);
        }
        // The flip: from here on the new value is the stored one.
        await backend.setItem(metaKey(key), `${generation}:${chunks.length}`);

        if (previous) await removeChunks(key, previous.generation, 0, previous.count);
      }),

    removeItem: (key) =>
      enqueue(async () => {
        const meta = parseMeta(await backend.getItem(metaKey(key)));
        await backend.removeItem(metaKey(key));
        if (meta) await removeChunks(key, meta.generation, 0, meta.count);
      }),
  };
}
