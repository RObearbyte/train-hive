/**
 * QA (M1-Q1 part 2): source-level rules from the Milestone 1 engineering
 * criteria, checked by reading `src/`: no colors outside the theme, no
 * secrets or service-role use, no leaked codes in logs or URLs, no swallowed
 * errors, accessible pressables, no client-side clock decisions on writes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const files = walk(SRC).filter((file) => !/\.test\.ts$/.test(file) && !file.endsWith('database.types.ts'));
const text = new Map(files.map((file) => [rel(file), readFileSync(file, 'utf8')] as const));

/** Source with line and block comments blanked out, line numbers preserved. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, lead: string) => lead);
}

describe('QA hygiene: colors, secrets, logging', () => {
  it('has no color literals outside src/ui/theme', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      if (file.startsWith('src/ui/theme/')) continue;
      for (const [index, line] of code(source).split('\n').entries()) {
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line)) found.push(`${file}:${index + 1}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('never references the service-role key or a secret env var', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      if (/SERVICE_ROLE|service_role_key|SUPABASE_SERVICE/i.test(code(source))) found.push(file);
      for (const m of code(source).matchAll(/process\.env\.(\w+)/g)) {
        if (!m[1].startsWith('EXPO_PUBLIC_')) found.push(`${file}: process.env.${m[1]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('only the known EXPO_PUBLIC_ variables are read from the environment', () => {
    const vars = new Set<string>();
    for (const [, source] of text) for (const m of code(source).matchAll(/process\.env\.(\w+)/g)) vars.add(m[1]);
    expect([...vars].sort()).toEqual([
      'EXPO_PUBLIC_APP_DOWNLOAD_URL',
      'EXPO_PUBLIC_CONTROLLER_ADDRESS',
      'EXPO_PUBLIC_CONTROLLER_NAME',
      'EXPO_PUBLIC_PRIVACY_EMAIL',
      'EXPO_PUBLIC_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_WEB_APP_URL',
    ]);
  });

  it('the only console call is the central error reporter', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      for (const [index, line] of code(source).split('\n').entries()) {
        if (/\bconsole\.(log|info|debug|error|warn)\b/.test(line)) found.push(`${file}:${index + 1}`);
      }
    }
    expect(found).toEqual(['src/lib/logger.ts:10']);
  });

  it('invitation codes and tokens are never put in a route, a URL or a log line', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      const body = code(source);
      // router.push / replace / Link href carrying a code or session
      for (const m of body.matchAll(/(?:push|replace|navigate|href=)\s*\(?\{?\s*[`'"][^`'"]*\$\{[^}]*(code|token|session\.access)/gi)) {
        found.push(`${file}: ${m[0]}`);
      }
      if (/params\s*:\s*\{[^}]*code/i.test(body)) found.push(`${file}: route params with code`);
      for (const m of body.matchAll(/reportError\([^)]*\b(code|accessToken|access_token|refresh_token)\b[^)]*\)/g)) {
        // reportError(context, error) is fine; a bare `code` variable is not.
        if (!/error\.code/.test(m[0])) found.push(`${file}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the stored session is never written to AsyncStorage or localStorage on native', () => {
    const asyncStorageUsers = [...text].filter(([, source]) => /async-storage/.test(code(source))).map(([file]) => file);
    expect(asyncStorageUsers).toEqual([]);
    const authStorage = text.get('src/lib/authStorage.ts') ?? '';
    expect(authStorage).toMatch(/Platform\.OS === 'web' \? webStorage\(\) : createChunkedStorage\(secureStoreBackend\)/);
  });
});

describe('QA hygiene: errors are not swallowed', () => {
  it('has no empty catch block and no catch that only returns', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      const body = code(source);
      for (const m of body.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) found.push(`${file}: ${m[0]}`);
      for (const m of body.matchAll(/\.catch\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)/g)) {
        found.push(`${file}: ${m[0]}`);
      }
    }
    // The storage queue keeps going after a failed task; the failure itself still reaches the caller.
    expect(found).toEqual(['src/lib/chunkedStorage.ts: .catch(() => undefined)']);
  });

  it('every .catch() on a floating promise reports the error', () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      for (const m of code(source).matchAll(/\.catch\(\s*\((\w*)(?::\s*unknown)?\)\s*=>\s*([^\n]*)/g)) {
        if (!/reportError|setProblem|setMapsFailed|throw/.test(m[2]) && m[1] === '') found.push(`${file}: ${m[0].replace(/;$/, '')}`);
      }
    }
    expect(found).toEqual(['src/lib/chunkedStorage.ts: .catch(() => undefined)']);
  });
});

describe('QA hygiene: accessibility of interactive elements', () => {
  it('every Pressable declares an accessibilityRole', () => {
    const missing: string[] = [];
    for (const [file, source] of text) {
      const body = code(source);
      for (const m of body.matchAll(/<Pressable\b/g)) {
        const window = body.slice(m.index, (m.index ?? 0) + 700);
        const tag = window.slice(0, window.indexOf('>') === -1 ? undefined : window.indexOf('>\n'));
        if (!/accessibilityRole/.test(tag)) {
          const line = body.slice(0, m.index).split('\n').length;
          missing.push(`${file}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('TextInputs go through TextField (which sets accessibilityLabel) rather than raw TextInput', () => {
    const raw = [...text]
      .filter(([file]) => file !== 'src/ui/components/TextField.tsx')
      .filter(([, source]) => /<TextInput\b/.test(code(source)))
      .map(([file]) => file);
    expect(raw).toEqual([]);
  });

  it('minimum touch target token is at least 44', () => {
    expect(readFileSync(path.join(SRC, 'ui/theme/tokens.ts'), 'utf8')).toMatch(/MIN_TOUCH_TARGET\s*=\s*(4[4-9]|[5-9]\d)/);
  });
});

describe('QA hygiene: the client clock', () => {
  it('only display code reads the device clock (new Date() / Date.now())', () => {
    const readers = [...text]
      .filter(([, source]) => /new Date\(\)|Date\.now\(\)/.test(code(source)))
      .map(([file]) => file)
      .sort();
    // useNow = display clock; the form and invitation form take a "now" for ADVISORY checks and for
    // the expiry preset; coalesce / chunked storage are timers only.
    expect(readers).toEqual([
      'src/features/invitations/components/CreateInvitationForm.tsx',
      // First-launch acknowledgement: a note kept on the device (informational); the server stamps the real consent record.
      'src/features/legal/hooks/useConsents.ts',
      'src/features/trainings/components/TrainingForm.tsx',
      'src/features/trainings/components/DateTimeField.native.tsx',
      'src/features/trainings/domain/coalesce.ts',
      'src/lib/useNow.ts',
    ].sort());
  });
});
