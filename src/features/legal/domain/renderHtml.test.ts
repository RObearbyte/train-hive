import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildLegalConfig } from '../config';
import { DRAFT_BANNER_TEXT, LEGAL_DOC_KINDS, PLACEHOLDER } from '../constants';
import { buildLegalDocument } from '../content';
import { escapeHtml, renderLegalPage } from './renderHtml';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'generate-legal-pages.mjs');

describe('escapeHtml', () => {
  it('escapes every character that can open markup or break an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
  });
});

describe('renderLegalPage', () => {
  const doc = buildLegalDocument('privacy', buildLegalConfig({}));
  const html = renderLegalPage(doc);

  it('is a complete, script-free page with the controller marker when nothing is configured', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(PLACEHOLDER);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('lang="en"');
    expect(html).toContain('<h1>Privacy Notice</h1>');
  });

  it('carries the draft banner while the documents are unreviewed, and not after', () => {
    expect(html).toContain(escapeHtml(DRAFT_BANNER_TEXT));
    expect(renderLegalPage(doc, { reviewed: true })).not.toContain('class="draft"');
  });

  it('supports light and dark and links the other document and the app', () => {
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain('href="/privacy.html"');
    expect(html).toContain('href="/"');
  });

  it('escapes hostile controller values instead of rendering them', () => {
    const hostile = buildLegalConfig({
      name: '<script>alert(1)</script> "Evil" & Co',
      address: '<img src=x onerror=alert(1)> Street',
      email: 'a@example.org',
    });
    const page = renderLegalPage(buildLegalDocument('terms', hostile));
    expect(page.toLowerCase()).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;Evil&quot; &amp; Co');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt; Street');
  });
});

describe('scripts/generate-legal-pages.mjs', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function generate(env: Record<string, string | undefined>): Record<string, string> {
    const out = mkdtempSync(path.join(os.tmpdir(), 'trainhive-legal-'));
    dirs.push(out);
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['EXPO_PUBLIC_CONTROLLER_NAME', 'EXPO_PUBLIC_CONTROLLER_ADDRESS', 'EXPO_PUBLIC_PRIVACY_EMAIL']) {
      delete cleanEnv[key];
    }
    execFileSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=DEP0205', SCRIPT, '--no-env-files', '--out', out],
      { cwd: ROOT, env: { ...cleanEnv, ...env }, stdio: 'pipe' },
    );
    return Object.fromEntries(LEGAL_DOC_KINDS.map((kind) => [kind, readFileSync(path.join(out, `${kind}.html`), 'utf8')]));
  }

  it('writes both pages with the placeholder when the environment variables are absent, and no script tag', () => {
    const pages = generate({});
    for (const kind of LEGAL_DOC_KINDS) {
      expect(pages[kind], kind).toContain(PLACEHOLDER);
      expect(pages[kind].toLowerCase(), kind).not.toContain('<script');
    }
  });

  it('puts configured values in the pages (and the placeholder disappears)', () => {
    const pages = generate({
      EXPO_PUBLIC_CONTROLLER_NAME: 'Fake Controller Ltd',
      EXPO_PUBLIC_CONTROLLER_ADDRESS: '1 Fake Street',
      EXPO_PUBLIC_PRIVACY_EMAIL: 'fake-privacy@example.org',
    });
    for (const kind of LEGAL_DOC_KINDS) {
      expect(pages[kind], kind).toContain('Fake Controller Ltd');
      expect(pages[kind], kind).toContain('fake-privacy@example.org');
      expect(pages[kind], kind).not.toContain(PLACEHOLDER);
    }
  });

  it('HTML-escapes hostile environment values and never emits a script tag', () => {
    const pages = generate({
      EXPO_PUBLIC_CONTROLLER_NAME: '<script>alert(1)</script>"><img src=x onerror=alert(2)>',
      EXPO_PUBLIC_CONTROLLER_ADDRESS: '</title><script src=//evil.example/x.js></script>',
      EXPO_PUBLIC_PRIVACY_EMAIL: '<script>@example.org',
    });
    for (const kind of LEGAL_DOC_KINDS) {
      const page = pages[kind];
      expect(page.toLowerCase(), kind).not.toContain('<script');
      expect(page, kind).not.toContain('<img');
      expect(page, kind).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      // The invalid e-mail was ignored, so the marker stands in for it.
      expect(page, kind).toContain(PLACEHOLDER);
    }
  });
});

describe('static hosting', () => {
  it('the SPA fallback does not force-rewrite the static legal pages', () => {
    const redirects = readFileSync(path.join(ROOT, 'public', '_redirects'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    // A non-forced rule (no "!") never replaces a file that exists, so /privacy.html and /terms.html stay static.
    expect(redirects).toEqual(['/*    /index.html   200']);
    expect(redirects.some((line) => line.includes('!'))).toBe(false);
  });

  it('the generated pages are git-ignored (they may hold the controllers details)', () => {
    const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('/public/privacy.html');
    expect(ignore).toContain('/public/terms.html');
  });
});
