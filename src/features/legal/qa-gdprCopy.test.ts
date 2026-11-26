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
  it('Q7-7: the notice describes About you, workout logs and event discussions (flags on, migrations present) and nothing unbuilt (flags off)', () => {
    expect(FEATURES).toEqual({ demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: true, accountLinking: true });
    const items = [
      { flag: FEATURES.demographics, phrase: 'Birth year and gender', column: 'birth_year' },
      { flag: FEATURES.emergencyContact, phrase: 'Emergency contact and T-shirt size', column: 'tshirt_size' },
      { flag: FEATURES.workoutLogs, phrase: 'Workout logs', column: 'private.workout_logs' },
      { flag: FEATURES.eventPosts, phrase: 'Announcements, posts, comments and replies in event discussions', column: 'public.event_posts' },
    ];
    for (const { flag, phrase, column } of items) {
      // The text mentions the data exactly when the flag is on...
      expect(privacyText.includes(phrase), `notice: ${phrase}`).toBe(flag);
      // ...and a flag is on only when the migrations really store that data (and off while they do not).
      expect(migrations.includes(column), `migration: ${phrase} -> ${column}`).toBe(flag);
    }
    // The group rules are stated because the data exists: 20 answers for demographics, 20 contributors for workout totals.
    expect(privacyText).toContain('rounded to the nearest 5');
    expect(privacyText).toContain('at least 20 members');
    expect(privacyText).toContain('only once at least 20 members have contributed');
    expect(privacyText).toContain('no member and no organizer can see an individual log');
    expect(privacyText).toContain('Workout logs: kept until you delete them, withdraw your consent');
    expect(termsText).toMatch(/emergency contact/i);
    // The Terms ask organizers to protect the contact; they say nothing about workouts.
    expect(termsText).not.toMatch(/workout/i);
    // Event discussions: what the notice says is what the migrations do.
    expect(privacyText).toContain('first 200 characters of its text');
    expect(migrations).toContain("select left(btrim(regexp_replace(p_body, '\\s+', ' ', 'g')), 200)");
    expect(privacyText).toContain('visible to the active members of that community');
    expect(privacyText).toContain('A deleted post, comment or reply keeps no text');
    expect(migrations).toContain('delete from public.event_posts ep where ep.author_id = p_user_id and ep.parent_id is not null;');
    expect(migrations).toContain('update public.event_posts ep set author_id = null where ep.author_id = p_user_id;');
    expect(privacyText).toContain('your comments and replies in event discussions');
    expect(privacyText).toContain('posts you wrote in event discussions');
    expect(termsText).toMatch(/Posts, comments and replies in an event discussion are visible to the active members/);
  });

  // Q7-7 (anonymous comments, gap D): every sentence about anonymity is tied to what the migration does.
  it('Q7-7: the anonymous-comment text matches the migration (author stored apart, nicknames per event, limit, erasure, no notification)', () => {
    // The author is not hidden from us: it is stored (private tables) and the notice says the operator can see it.
    expect(migrations).toContain('create table private.event_post_anonymous_authors');
    expect(migrations).toContain('create table private.event_aliases');
    expect(privacyText).toContain('The person who operates the database can technically see who wrote it');
    expect(privacyText).not.toMatch(/fully anonymous|not even we can|completely anonymous/i);
    // No API role can read the author, so no member or organizer can.
    expect(migrations).toContain('revoke all on table private.event_post_anonymous_authors from public, anon, authenticated, service_role;');
    expect(migrations).toContain('revoke all on table private.event_aliases from public, anon, authenticated, service_role;');
    expect(privacyText).toContain('other members and organizers then see a nickname for that event instead of your name');
    expect(privacyText).toContain('you get a different nickname on each event');
    expect(migrations).toContain('constraint event_aliases_pkey primary key (session_id, user_id)');
    // Organizers cannot be anonymous; the limit is 10 per hour.
    expect(migrations).toContain('anonymous_not_allowed');
    expect(privacyText).toContain('Members (not organizers) can choose');
    expect(privacyText).toContain('at most 10 anonymous comments or replies per person per event per hour');
    // Erasure: comments and replies (anonymous too) and nicknames go; organizer posts stay without a name.
    expect(migrations).toContain("delete from public.event_posts ep where ep.author_id = p_user_id and ep.kind = 'comment';");
    expect(migrations).toContain('delete from private.event_aliases al where al.user_id = p_user_id;');
    expect(privacyText).toContain('your comments and replies are deleted, anonymous ones included, together with your nicknames');
    // Comments notify nobody; a reply notifies the author of the item answered, with the nickname when anonymous.
    expect(privacyText).toContain('New comments do not send any notification');
    expect(privacyText).toContain('or the nickname if the reply is anonymous');
    // Terms: no harassment, anonymity does not protect from removal.
    expect(termsText).toContain('Do not harass, insult or threaten anyone');
    expect(termsText).toContain('anonymity does not protect a comment from removal');
    expect(termsText).toContain('TrainHive still stores who wrote the comment');
  });

  // Q7-7 (personal records, gap E): what the notice says about records is what the migration does.
  it('Q7-7: the personal-records text matches the migration (stored only when confirmed, owner only, cascades, export)', () => {
    expect(FEATURES.workoutLogs).toBe(true);
    // Lift records: one stored row per confirmation (lift, reps, weight, event, time), no API privilege.
    expect(migrations).toContain('create table private.lift_max_efforts');
    expect(migrations).toContain('revoke all on table private.lift_max_efforts from public, anon, authenticated, service_role;');
    expect(privacyText).toContain('Personal records (part of your workout logs)');
    expect(privacyText).toContain('come only from sets you confirm as a maximal effort');
    expect(privacyText).toContain('we then store the lift, the repetitions, the weight, the event and when you confirmed it');
    // Running bests are computed, not stored (no table for them).
    expect(migrations).not.toMatch(/create table [\w.]*running/i);
    expect(privacyText).toContain('nothing extra is stored for them');
    // Same consent: confirming needs it.
    expect(migrations).toContain("message = 'consent_required:workout_logs'");
    expect(privacyText).toContain('under the same explicit consent as your workout logs (confirming a set needs it)');
    // Owner only: no organizer reads them, no aggregate.
    expect(privacyText).toContain('no member and no organizer can see them, and no community total uses them');
    // Deleted with the set, the log (cascade), the withdrawal and the account; included in the download.
    expect(migrations).toContain('references private.workout_logs (user_id, session_id) on delete cascade');
    expect(privacyText).toContain('A confirmed lift record is deleted when its set is no longer in the log');
    expect(privacyText).toContain(', all your workout logs and personal records');
    expect(migrations).toContain("'personal_records', jsonb_build_object(");
    expect(privacyText).toContain('including your workout logs and personal records');
    // Never "verified" or "official": they are the member's own entries.
    expect(privacyText).toContain('Records are your own entries, not verified or official results');
    expect(privacyText).not.toMatch(/(?<!not )verified records|official records/i);
    // The Terms say nothing about workouts or records.
    expect(termsText).not.toMatch(/personal record|max(imal)? effort/i);
  });

  // Q7-7 (account linking): the optional email lives only in Supabase Auth; the texts say so and the code agrees.
  it('Q7-7: the notice and terms describe the optional email exactly when accountLinking is on, and the migrations never copy it into TrainHive tables', () => {
    expect(FEATURES.accountLinking).toBe(true);
    expect(privacyText).toContain('Email address (optional)');
    expect(privacyText).toContain('used only to let you sign in again on another device and to send you sign-in codes');
    expect(privacyText).toContain('Basis: your consent, which you give by adding it');
    expect(privacyText).toContain('Email address (if you added one): kept until you delete your account');
    expect(privacyText).toContain(', the email address you added');
    expect(termsText).toContain('Add only an email address that is yours');
    // Nothing in the database reads or stores auth.users.email: it is not in the export, in any table or in a function.
    expect(migrations).not.toMatch(/\b\w+\.email\b/);
    expect(migrations).not.toMatch(/auth\.users[^;]*\bemail\b/i);
    // Retention only ever touches anonymous accounts: a linked account is never erased by the clean-up.
    expect(migrations).toMatch(/where u\.is_anonymous/);
    // Erasing an account deletes the auth user, and with it the email.
    expect(migrations).toContain('delete from auth.users');
    // The app links with the documented Auth calls only (no OAuth, no password).
    const api = read('src', 'features', 'account', 'api', 'emailAuth.ts');
    expect(api).toContain('updateUser({ email');
    expect(api).toContain("type: 'email_change'");
    expect(api).toContain('shouldCreateUser: false');
    const app = [api, read('src', 'features', 'account', 'components', 'EmailCodeFlow.tsx')].join('\n');
    expect(app).not.toMatch(/signInWithOAuth|signInWithPassword|password:/);
  });

  it('Q7-7: with accountLinking off the texts do not mention the email at all', () => {
    const off = { ...FEATURES, accountLinking: false };
    const privacyOff = JSON.stringify(buildPrivacyNotice(config as never, off));
    const termsOff = JSON.stringify(buildTerms(config as never, off));
    for (const phrase of ['Email address (optional)', 'sign-in codes', 'Secure your account', 'unless you added an email']) {
      expect(privacyOff.includes(phrase), phrase).toBe(false);
    }
    expect(termsOff).not.toMatch(/email address that is yours|add an email/i);
    expect(privacyOff).toContain('TrainHive has no email address or password');
  });

  it('Q7-7: with the About-you flags off the texts say nothing about the data (the guard for a flag that is false)', () => {
    const off = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false, accountLinking: false };
    const privacyOff = JSON.stringify(buildPrivacyNotice(config as never, off));
    const termsOff = JSON.stringify(buildTerms(config as never, off));
    for (const phrase of ['Birth year and gender', 'Emergency contact', 'Workout logs', 'rounded to the nearest 5', 'event discussions', 'first 200 characters']) {
      expect(privacyOff.includes(phrase), phrase).toBe(false);
    }
    expect(termsOff).not.toMatch(/emergency contact|workout|event discussion|replies/i);
  });

  it('Q7-7: with every flag on, the notice names each item and the 5-person rule', () => {
    const all = { demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: true, accountLinking: true };
    const text = JSON.stringify(buildPrivacyNotice(config as never, all));
    for (const phrase of ['Birth year and gender', 'Emergency contact and T-shirt size', 'Workout logs', 'rounded to the nearest 5']) {
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
      'securePromptStorageKey',
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
