/**
 * QA review of GDPR G1 + G2 (Q7): the legal texts and the app checked against what the code and
 * the migrations actually do, by reading source as text. Nothing is mocked and no real personal
 * data is used. Tests marked DEFECT Q7-n are `it.fails`: they state the expected behaviour and
 * turn red when the defect is fixed (remove `.fails` then).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEATURES } from './constants';
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
  // Q7-7 (fixed, updated for P3): the texts name a data item exactly when its flag is on AND the migrations
  // build it; later phases flip a flag in constants.ts in the same change that ships the feature.
  it('Q7-7: the notice describes About you (flags on, migration present) and nothing unbuilt (flags off)', () => {
    expect(FEATURES).toEqual({ demographics: true, emergencyContact: true, workoutLogs: false, eventPosts: false });
    const items = [
      { flag: FEATURES.demographics, phrase: 'Birth year and gender', column: 'birth_year' },
      { flag: FEATURES.emergencyContact, phrase: 'Emergency contact and T-shirt size', column: 'tshirt_size' },
      { flag: FEATURES.workoutLogs, phrase: 'Workout logs', column: 'public.workout_logs ' },
    ];
    for (const { flag, phrase, column } of items) {
      // The text mentions the data exactly when the flag is on...
      expect(privacyText.includes(phrase), `notice: ${phrase}`).toBe(flag);
      // ...and a flag is on only when the migrations really store that data (and off while they do not).
      expect(migrations.includes(column), `migration: ${phrase} -> ${column}`).toBe(flag);
    }
    // The 5-person rule is stated because demographics exist; the Terms ask organizers to protect the contact, not workouts.
    expect(privacyText).toContain('groups of 5 or more');
    expect(termsText).toMatch(/emergency contact/i);
    expect(termsText).not.toMatch(/workout/i);
    expect(privacyText).not.toMatch(/workout/i);
  });

  it('Q7-7: with the About-you flags off the texts say nothing about the data (the guard for a flag that is false)', () => {
    const off = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false };
    const privacyOff = JSON.stringify(buildPrivacyNotice(config as never, off));
    const termsOff = JSON.stringify(buildTerms(config as never, off));
    for (const phrase of ['Birth year and gender', 'Emergency contact', 'Workout logs', 'groups of 5 or more']) {
      expect(privacyOff.includes(phrase), phrase).toBe(false);
    }
    expect(termsOff).not.toMatch(/emergency contact|workout/i);
  });

  it('Q7-7: with every flag on, the notice names each item and the 5-person rule', () => {
    const all = { demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: true };
    const text = JSON.stringify(buildPrivacyNotice(config as never, all));
    for (const phrase of ['Birth year and gender', 'Emergency contact and T-shirt size', 'Workout logs', 'groups of 5 or more']) {
      expect(text).toContain(phrase);
    }
  });

  // Q7-9 (fixed): no screen shows an author, so the notice does not promise a "Former member" author.
  it('Q7-9: the notice makes no claim about an announcement author', () => {
    expect(privacyText).not.toContain('Former member');
    expect(privacyText).toContain('they are no longer linked to you');
  });

  it('Q7-5: Terms say removal is final (no rejoin by code); the backend refuses every code', () => {
    expect(termsText).toContain('cannot rejoin with an invitation code: removal is final for that account');
    expect(termsText).not.toContain('invite them again');
    expect(migrations).toContain('A removed member cannot rejoin by code.');
    expect(/function public\.(reinstate|restore|readd)_member/i.test(migrations)).toBe(false);
  });

  it('the retention numbers stated in the notice are the ones the purge function uses', () => {
    expect(privacyText).toContain('more than 90 days old if you have read them');
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
  // Q7-8 (fixed): the downloaded data file is removed after sign out and after deletion.
  it('Q7-8: sign out and account deletion remove the exported data file', () => {
    const cleanup = [
      read('src', 'features', 'profile', 'domain', 'signOut.ts'),
      read('src', 'features', 'profile', 'hooks', 'useSignOut.ts'),
      read('src', 'features', 'dataRights', 'hooks', 'useDeleteAccount.ts'),
      read('src', 'features', 'dataRights', 'domain', 'deletion.ts'),
    ].join('\n');
    expect(/removeExportedFiles/.test(cleanup)).toBe(true);
  });

  it('the stored acknowledgement, push prompt flag, session and active community are cleared', () => {
    const signOut = read('src', 'features', 'profile', 'domain', 'signOut.ts');
    for (const key of [
      'ACCEPTANCE_STORAGE_KEY',
      'PUSH_PROMPT_DISMISSED_KEY',
      'authStorageKey',
      'activeCommunityStorageKey',
      'aboutYouPromptStorageKey',
    ]) {
      expect(signOut).toContain(key);
    }
  });

  // Q7-10 (fixed): a person who does not accept updated terms can still export or delete.
  it('Q7-10: the blocking terms screen offers Delete my account / Download my data without accepting', () => {
    const screen = read('src', 'features', 'legal', 'components', 'TermsUpdateScreen.tsx');
    expect(screen).toContain('<DownloadMyData');
    expect(screen).toContain('<DeleteAccountFlow');
  });
});

describe('legal text and repository hygiene', () => {
  it('the bundled legal texts contain no e-mail address or phone number of their own', () => {
    const own = (privacyText + termsText).split(config.privacyEmail).join('').replace(/dataprotection\.ro/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '');
    expect(own).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(own).not.toMatch(/\+?\d[\d ()-]{8,}\d/);
  });
});
