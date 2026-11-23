import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLegalConfig } from '../config';
import {
  BUNDLED_TERMS_PRIVACY_VERSION,
  DRAFT_BANNER_TEXT,
  FEATURES,
  LEGAL_DOC_KINDS,
  LEGAL_LAST_UPDATED,
  LEGAL_REVIEWED,
  MINIMUM_AGE,
  PLACEHOLDER,
  PRIVACY_VERSION,
  SUPERVISORY_AUTHORITY,
  TERMS_VERSION,
  parseLegalDocKind,
  type LegalFeatures,
} from '../constants';
import { buildLegalDocument, type LegalDocument } from './index';

const FAKE = buildLegalConfig({
  name: 'Fake Controller Ltd',
  address: '1 Fake Street, Faketown',
  email: 'fake-privacy@example.org',
});
const EMPTY = buildLegalConfig({});

function textOf(doc: LegalDocument): string {
  const parts: string[] = [doc.title, doc.intro];
  for (const section of doc.sections) {
    parts.push(section.heading);
    for (const block of section.blocks) {
      if (block.type === 'paragraph') parts.push(block.text);
      else if (block.type === 'list') parts.push(...block.items);
      else for (const row of block.rows) parts.push(row.label, row.value);
    }
  }
  return parts.join('\n');
}

describe('version constants', () => {
  // Version 2 describes About you (birth year, gender, emergency contact, T-shirt size). The server is seeded
  // with '1': publish '2' with admin_set_legal_version when this build is in use, so members are asked again.
  it('are version 2, the texts that describe About you', () => {
    expect(TERMS_VERSION).toBe('2');
    expect(PRIVACY_VERSION).toBe('2');
    expect(BUNDLED_TERMS_PRIVACY_VERSION).toBe('terms:2|privacy:2');
  });

  it('the combined version fits the server pattern for a version string', () => {
    expect(TERMS_VERSION).toMatch(/^[A-Za-z0-9._-]{1,20}$/);
    expect(PRIVACY_VERSION).toMatch(/^[A-Za-z0-9._-]{1,20}$/);
  });

  it('the last-updated date is a real ISO date', () => {
    expect(LEGAL_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(LEGAL_LAST_UPDATED))).toBe(false);
  });

  it('minimum age is 16 and the authority is ANSPDCP with its public website', () => {
    expect(MINIMUM_AGE).toBe(16);
    expect(SUPERVISORY_AUTHORITY.shortName).toBe('ANSPDCP');
    expect(SUPERVISORY_AUTHORITY.website).toBe('https://www.dataprotection.ro');
  });

  it('the documents are marked as drafts until a lawyer has reviewed them', () => {
    expect(LEGAL_REVIEWED).toBe(false);
    expect(DRAFT_BANNER_TEXT).toMatch(/^Draft/);
    expect(DRAFT_BANNER_TEXT).toMatch(/reviewed by a lawyer before launch/);
  });

  it('parses a document route parameter strictly', () => {
    expect(parseLegalDocKind('privacy')).toBe('privacy');
    expect(parseLegalDocKind('terms')).toBe('terms');
    for (const value of ['Privacy', '../x', '', undefined, null, 1, ['privacy']]) {
      expect(parseLegalDocKind(value)).toBeNull();
    }
  });
});

describe.each(LEGAL_DOC_KINDS)('%s document integrity', (kind) => {
  const doc = buildLegalDocument(kind, FAKE);

  it('has its version, a date, a title and an intro', () => {
    expect(doc.kind).toBe(kind);
    expect(doc.version).toBe(kind === 'terms' ? TERMS_VERSION : PRIVACY_VERSION);
    expect(doc.lastUpdated).toBe(LEGAL_LAST_UPDATED);
    expect(doc.title.length).toBeGreaterThan(3);
    expect(doc.intro.length).toBeGreaterThan(20);
  });

  it('every section has a heading and real text in every block', () => {
    expect(doc.sections.length).toBeGreaterThanOrEqual(8);
    for (const section of doc.sections) {
      expect(section.heading.trim().length, section.id).toBeGreaterThan(3);
      expect(section.blocks.length, section.id).toBeGreaterThan(0);
      for (const block of section.blocks) {
        if (block.type === 'paragraph') expect(block.text.trim().length, section.id).toBeGreaterThan(10);
        else if (block.type === 'list') {
          expect(block.items.length, section.id).toBeGreaterThan(0);
          for (const item of block.items) expect(item.trim().length, section.id).toBeGreaterThan(5);
        } else {
          expect(block.rows.length, section.id).toBeGreaterThan(0);
          for (const row of block.rows) {
            expect(row.label.trim().length, section.id).toBeGreaterThan(2);
            expect(row.value.trim().length, section.id).toBeGreaterThan(2);
          }
        }
      }
    }
  });

  it('section ids are unique and URL-safe', () => {
    const ids = doc.sections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('has no leftover template markers or accidental values', () => {
    const text = textOf(doc);
    expect(text).not.toMatch(/\{\{|\}\}|\$\{|undefined|\[object|\bNaN\b|\bnull\b|TODO|FIXME|XXX/);
    expect(text).not.toMatch(/lorem ipsum/i);
    // A fully configured build shows no placeholder at all.
    expect(text).not.toContain(PLACEHOLDER);
  });

  it('shows the placeholder (and only through the config) when nothing is configured', () => {
    const text = textOf(buildLegalDocument(kind, EMPTY));
    expect(text).toContain(PLACEHOLDER);
  });
});

describe('the controller block uses the config only', () => {
  const privacy = buildLegalDocument('privacy', FAKE);
  const terms = buildLegalDocument('terms', FAKE);

  it('the privacy notice names the configured controller, address and contact', () => {
    const controller = privacy.sections.find((section) => section.id === 'controller');
    expect(controller).toBeDefined();
    const facts = controller?.blocks.find((block) => block.type === 'facts');
    expect(facts?.type === 'facts' ? facts.rows.map((row) => row.value) : []).toEqual([
      FAKE.controllerName,
      FAKE.controllerAddress,
      FAKE.privacyEmail,
    ]);
  });

  it('the terms name the configured operator', () => {
    const text = textOf(terms);
    expect(text).toContain(FAKE.controllerName);
    expect(text).toContain(FAKE.privacyEmail);
  });

  it('the content sources contain no e-mail address, phone number or street address of their own', () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const file of sources) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(source, file).not.toMatch(/\+?\d[\d\s-]{8,}\d/);
      expect(source, file).not.toMatch(/\bhttps?:\/\//);
      expect(source, file).not.toMatch(/\b(?:Strada|Str\.|Street|Bd\.|Bulevardul)\s+\w+\s+(?:nr|no)?\.?\s*\d+/i);
    }
  });
});

describe('what the privacy notice must say (GDPR plan sections 1 to 4)', () => {
  const text = textOf(buildLegalDocument('privacy', FAKE));

  it.each([
    ['Supabase', /Supabase/],
    ['Expo', /Expo/],
    ['Google Firebase Cloud Messaging', /Google Firebase Cloud Messaging/],
    ['the web hosting provider', /hosting provider/],
    ['transfers outside the EEA and standard contractual clauses', /outside the European Economic Area[\s\S]*standard contractual clauses/],
    ['read notifications 90 days', /90 days/],
    ['unread notifications 180 days', /180 days/],
    ['failed attempts 24 hours', /24 hours/],
    ['account data until deletion', /until you delete your account/],
    ['the supervisory authority', /ANSPDCP/],
    ['its website', /https:\/\/www\.dataprotection\.ro/],
    ['age 16', /aged 16 or older/],
    ['anonymous accounts', /Anonymous accounts/],
    ['no analytics', /no analytics, advertising or tracking/i],
    ['web local storage', /local storage/],
    ['withdrawing consent', /withdraw a consent at any time/],
    ['security measures', /row-level security/],
  ])('mentions %s', (_name, pattern) => {
    expect(text).toMatch(pattern);
  });

  it('describes the data rights that exist in the app, and points to the contact for the rest', () => {
    expect(text).toMatch(/Profile, then Privacy/);
    expect(text).toMatch(/Profile, then Privacy, then Download my data/);
    expect(text).toMatch(/Profile, then Privacy, then Delete my account/);
    expect(text).not.toMatch(/not yet available in the app/);
    expect(text).not.toMatch(/coming soon/i);
    expect(text).toMatch(/Restrict or object to processing: contact us at/);
  });

  it('says what deletion keeps anonymously and what blocks it', () => {
    expect(text).toMatch(/Attendance counts and the attendance change history stay without your name/);
    expect(text).toMatch(/no longer linked to you/);
    expect(text).not.toMatch(/Former member/);
    expect(text).toMatch(/only organizer of a community that still has other members/);
    expect(text).toMatch(/deleted together with your account/);
  });

  it('mentions organizers removing members and leaving a community', () => {
    expect(text).toMatch(/remove a member from the community/);
    expect(text).toMatch(/Leave this community/);
  });

  it('terms cover the required topics and the governing law', () => {
    const terms = textOf(buildLegalDocument('terms', FAKE));
    for (const pattern of [
      /Acceptable use/,
      /Organizers/,
      /not copy, export, publish or share/,
      /What you post/,
      /Availability/,
      /liability/i,
      /Ending your use/,
      /Delete my account/,
      /leave a single community/,
      /cannot rejoin with an invitation code: removal is final/,
      /law of Romania/,
    ]) {
      expect(terms).toMatch(pattern);
    }
  });
});

const OFF: LegalFeatures = { demographics: false, emergencyContact: false, workoutLogs: false, eventPosts: false };
/** What ships now: About you and workout logs are built (backend, app and these texts); event posts are not described yet. */
const SHIPPED: LegalFeatures = { demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: false };
const ON: LegalFeatures = { demographics: true, emergencyContact: true, workoutLogs: true, eventPosts: true };
const SINGLE: [keyof LegalFeatures, RegExp][] = [
  ['demographics', /birth year|gender|rounded to the nearest 5/i],
  ['emergencyContact', /emergency contact|T-shirt/i],
  ['workoutLogs', /workout/i],
  ['eventPosts', /event discussions|replies/i],
];

describe('later-phase features appear in the texts only when their flag is on', () => {
  it('ships with About you and workout logs on and the later features still off', () => {
    expect(FEATURES).toEqual(SHIPPED);
  });

  it.each(LEGAL_DOC_KINDS)('%s: with every flag off, no later-phase feature is mentioned', (kind) => {
    const text = textOf(buildLegalDocument(kind, FAKE, OFF));
    for (const [, pattern] of SINGLE) expect(text).not.toMatch(pattern);
    expect(text).not.toMatch(/explicit consent/);
    expect(text).not.toMatch(/special-category/);
  });

  it.each(LEGAL_DOC_KINDS)('%s: the default is the shipped state', (kind) => {
    expect(textOf(buildLegalDocument(kind, FAKE))).toBe(textOf(buildLegalDocument(kind, FAKE, SHIPPED)));
    expect(textOf(buildLegalDocument(kind, FAKE))).not.toBe(textOf(buildLegalDocument(kind, FAKE, OFF)));
  });

  it('privacy (shipped): says what About you stores, why, who sees it and how long it is kept', () => {
    const text = textOf(buildLegalDocument('privacy', FAKE));
    expect(text).toMatch(/Birth year and gender \(optional\)/);
    expect(text).toMatch(/Emergency contact and T-shirt size \(optional\)/);
    expect(text).toMatch(/name, phone number and relationship/);
    expect(text).toMatch(/safety at events and for race kits/);
    expect(text).toMatch(/visible to the organizers of the communities you belong to/);
    expect(text).toMatch(/Other members cannot see them/);
    expect(text).toMatch(/never see your birth year or gender next to your name/);
    expect(text).toMatch(/approximate group totals for the whole community, rounded to the nearest 5, and only once at least 20 members have answered/);
    expect(text).toMatch(/Groups of fewer than 5 people are hidden/);
    expect(text).not.toMatch(/one by one/);
    expect(text).toMatch(/Birth year and gender: kept until you withdraw your consent \(which deletes them\), clear them yourself or delete your account/);
    expect(text).toMatch(/Emergency contact and T-shirt size: kept until you withdraw your consent/);
    expect(text).toMatch(/Profile, then About you/);
    expect(text).toMatch(/explicit consent/);
    expect(text).toMatch(/Notification texts never contain workout data or emergency contact details/);
    // Still not promised: event discussions.
    expect(text).not.toMatch(/event discussions|replies/i);
  });

  it('privacy (shipped): says what workout logs hold, why, who sees them and how long they are kept', () => {
    const text = textOf(buildLegalDocument('privacy', FAKE));
    expect(text).toContain('Workout logs (optional)');
    expect(text).toContain('exercises (names, repetitions and weights), distance, time, pace and notes');
    expect(text).toMatch(/special-category data/);
    expect(text).toMatch(/no member and no organizer can see an individual log/);
    expect(text).toMatch(/only once at least 5 members have contributed/);
    expect(text).toContain('Workout logs: kept until you delete them, withdraw your consent (which deletes all of them) or delete your account');
    expect(text).toMatch(/Profile, then My workouts/);
  });

  it('terms (shipped): organizers must treat the shared emergency contact and T-shirt size with care', () => {
    const text = textOf(buildLegalDocument('terms', FAKE));
    expect(text).toMatch(/emergency contact and T-shirt size\) with particular care/);
    expect(text).toMatch(/only for safety at events and for race kits/);
    expect(text).not.toMatch(/workout/i);
  });

  it('privacy: each flag adds its own text and nothing of the others', () => {
    for (const [flag, pattern] of SINGLE) {
      const text = textOf(buildLegalDocument('privacy', FAKE, { ...OFF, [flag]: true }));
      expect(text, flag).toMatch(pattern);
      for (const [other, otherPattern] of SINGLE) {
        if (other === flag) continue;
        expect(text, flag + ' must not bring ' + other).not.toMatch(otherPattern);
      }
    }
  });

  it.each(LEGAL_DOC_KINDS)('%s: with every flag on, all of it is described and the 5-person rule is stated', (kind) => {
    const text = textOf(buildLegalDocument(kind, FAKE, ON));
    if (kind === 'privacy') {
      expect(text).toMatch(/rounded to the nearest 5/);
      expect(text).toMatch(/at least 20 members/);
      expect(text).toMatch(/explicit consent/);
      expect(text).toMatch(/Workout logs/);
      expect(text).toMatch(/Emergency contact and T-shirt size/);
      expect(text).toMatch(/Birth year and gender/);
    }
    expect(text).toMatch(/event discussions|replies/);
  });

  it.each(LEGAL_DOC_KINDS)('%s: every flag combination is coherent (no empty blocks, no leftovers)', (kind) => {
    const keys = Object.keys(OFF) as (keyof LegalFeatures)[];
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const features = Object.fromEntries(keys.map((key, i) => [key, (mask & (1 << i)) !== 0])) as LegalFeatures;
      const doc = buildLegalDocument(kind, FAKE, features);
      const text = textOf(doc);
      expect(text, String(mask)).not.toMatch(/undefined|\[object|\bNaN\b|\bnull\b|\bfalse\b|\btrue\b/);
      for (const section of doc.sections) {
        for (const block of section.blocks) {
          if (block.type === 'list') expect(block.items.length).toBeGreaterThan(0);
          if (block.type === 'facts') expect(block.rows.length).toBeGreaterThan(0);
        }
      }
      if (kind === 'privacy') {
        const anyOptional = features.demographics || features.emergencyContact || features.workoutLogs;
        expect(/Each optional consent has its own switch/.test(text), String(mask)).toBe(anyOptional);
      }
    }
  });

  it('the removal rule is stated the same way in both documents', () => {
    const privacy = textOf(buildLegalDocument('privacy', FAKE));
    const terms = textOf(buildLegalDocument('terms', FAKE));
    expect(privacy).toMatch(/Removal is final for that account/);
    expect(terms).toMatch(/cannot rejoin with an invitation code: removal is final/);
    expect(terms + privacy).not.toMatch(/invite them again/);
  });

  it('push device identifiers are described as removed when the device stops working', () => {
    expect(textOf(buildLegalDocument('privacy', FAKE))).toMatch(/when a device stops working, within 30 days/);
  });
});
