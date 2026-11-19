import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLegalConfig } from '../config';
import {
  BUNDLED_TERMS_PRIVACY_VERSION,
  DRAFT_BANNER_TEXT,
  LEGAL_DOC_KINDS,
  LEGAL_LAST_UPDATED,
  LEGAL_REVIEWED,
  MINIMUM_AGE,
  PLACEHOLDER,
  PRIVACY_VERSION,
  SUPERVISORY_AUTHORITY,
  TERMS_VERSION,
  parseLegalDocKind,
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
  it('match the versions seeded on the server', () => {
    expect(TERMS_VERSION).toBe('1');
    expect(PRIVACY_VERSION).toBe('1');
    expect(BUNDLED_TERMS_PRIVACY_VERSION).toBe('terms:1|privacy:1');
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
    ['groups of 5', /groups of 5 or more/],
    ['withdrawing consent', /withdraw a consent at any time/],
    ['legal basis for consent', /explicit consent/],
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
    expect(text).toMatch(/"Former member"/);
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
      /cannot rejoin with an invitation code/,
      /law of Romania/,
    ]) {
      expect(terms).toMatch(pattern);
    }
  });
});
