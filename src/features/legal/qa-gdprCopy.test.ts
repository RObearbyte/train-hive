/**
 * QA review of GDPR G1 + G2 (Q7): the legal texts and the app checked against what the code and
 * the migrations actually do, by reading source as text. Nothing is mocked and no real personal
 * data is used. Tests marked DEFECT Q7-n are `it.fails`: they state the expected behaviour and
 * turn red when the defect is fixed (remove `.fails` then).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPrivacyNotice } from './content/privacy';
import { buildTerms } from './content/terms';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const migrations = readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read('supabase', 'migrations', f))
  .join('\n');

const config = { controllerName: 'Test Controller', controllerAddress: 'Nowhere 1', privacyEmail: 'privacy@example.invalid' };
const privacyText = JSON.stringify(buildPrivacyNotice(config as never));
const termsText = JSON.stringify(buildTerms(config as never));

describe('texts versus what exists', () => {
  // DEFECT Q7-7: the notice describes data and a statistics rule that no code implements yet.
  it.fails('DEFECT Q7-7: every optional data item and rule the notice names exists in the schema', () => {
    for (const [phrase, column] of [
      ['Birth year and gender', 'birth_year'],
      ['Emergency contact and T-shirt size', 'emergency_contact'],
      ['Workout logs', 'workout_log'],
    ] as const) {
      expect(privacyText.includes(phrase), phrase).toBe(true);
      expect(migrations.includes(column), `${phrase} -> ${column}`).toBe(true);
    }
    // "only for groups of 5 or more people": a threshold must exist in some statistics function.
    expect(privacyText).toContain('groups of 5 or more');
    expect(/having\s+count\(\*\)\s*>=\s*5|>=\s*5\b[^;]{0,80}(birth|gender|demograph)/i.test(migrations)).toBe(true);
  });

  // DEFECT Q7-9: announcements never show an author, so "show Former member as the author" is untrue.
  it.fails('DEFECT Q7-9: the announcement screens display an author, so "Former member" can appear', () => {
    expect(privacyText).toContain('Former member');
    const screens = [
      read('src', 'app', '(app)', 'announcements', '[id].tsx'),
      ...readdirSync(path.join(ROOT, 'src', 'features', 'notifications', 'components')).map((f) =>
        read('src', 'features', 'notifications', 'components', f),
      ),
    ].join('\n');
    expect(/Former member|author_id|authorName/.test(screens)).toBe(true);
  });

  it('Terms say a removed member needs a new invitation; the backend refuses every code (see Q7-5 in qa-gdpr-consent)', () => {
    expect(termsText).toContain('cannot rejoin with an invitation code and needs an organizer to invite them again');
    expect(migrations).toContain('A removed member cannot rejoin by code.');
    expect(/function public\.(reinstate|restore|readd)_member/i.test(migrations)).toBe(false);
  });

  it('the retention numbers stated in the notice are the ones the purge function uses', () => {
    expect(privacyText).toContain('90 days after you read them');
    expect(migrations).toMatch(/read_at is not null and n\.created_at < now\(\) - interval '90 days'/);
    expect(migrations).toMatch(/read_at is null and n\.created_at < now\(\) - interval '180 days'/);
    expect(migrations).toMatch(/attempted_at < now\(\) - interval '24 hours'/);
  });

  it('the notice and terms name no analytics, advertising or tracking SDK in package.json', () => {
    const pkg = read('package.json');
    for (const name of ['analytics', 'sentry', 'amplitude', 'mixpanel', 'firebase/analytics', 'expo-insights', 'adjust']) {
      expect(pkg.includes(name), name).toBe(false);
    }
  });
});

describe('local cleanup after sign out and account deletion', () => {
  // DEFECT Q7-8: the downloaded data file stays in the cache after sign out and after deletion.
  it.fails('DEFECT Q7-8: sign out and account deletion remove the exported data file', () => {
    const cleanup = [
      read('src', 'features', 'profile', 'domain', 'signOut.ts'),
      read('src', 'features', 'profile', 'hooks', 'useSignOut.ts'),
      read('src', 'features', 'dataRights', 'hooks', 'useDeleteAccount.ts'),
      read('src', 'features', 'dataRights', 'domain', 'deletion.ts'),
    ].join('\n');
    expect(/removeOldExports|trainhive-data|clearExport/.test(cleanup)).toBe(true);
  });

  it('the stored acknowledgement, push prompt flag, session and active community are cleared', () => {
    const signOut = read('src', 'features', 'profile', 'domain', 'signOut.ts');
    for (const key of ['ACCEPTANCE_STORAGE_KEY', 'PUSH_PROMPT_DISMISSED_KEY', 'authStorageKey', 'activeCommunityStorageKey']) {
      expect(signOut).toContain(key);
    }
  });

  // DEFECT Q7-10: a person who does not accept updated terms has no path to export or delete.
  it.fails('DEFECT Q7-10: the blocking terms screen offers Delete my account / Download my data without accepting', () => {
    const screen = read('src', 'features', 'legal', 'components', 'TermsUpdateScreen.tsx');
    expect(/DeleteAccount|DownloadMyData|\/privacy/.test(screen.replace(/Privacy Notice|Privacy contact/g, ''))).toBe(true);
  });
});

describe('legal text and repository hygiene', () => {
  it('the bundled legal texts contain no e-mail address or phone number of their own', () => {
    const own = (privacyText + termsText).split(config.privacyEmail).join('').replace(/dataprotection\.ro/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '');
    expect(own).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(own).not.toMatch(/\+?\d[\d ()-]{8,}\d/);
  });
});
