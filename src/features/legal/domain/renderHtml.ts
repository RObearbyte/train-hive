/**
 * Renders a legal document as a standalone, script-free HTML page (the static
 * pages `privacy.html` and `terms.html` of the web version). Pure TypeScript
 * that plain Node can load (scripts/generate-legal-pages.mjs): relative
 * imports only, no react-native.
 *
 * Every value that came from outside (the controller's details, any text) is
 * HTML-escaped; there is no markup in the content model to begin with. A
 * Content-Security-Policy meta tag forbids scripts as a second line.
 */
import { darkColors, lightColors } from '../../../ui/theme/colors';
import type { LegalDocument } from '../content/types';
import { DRAFT_BANNER_TEXT, LEGAL_DOC_TITLES, LEGAL_REVIEWED } from '../constants';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function palette(colors: typeof lightColors): string {
  return [
    `--bg:${colors.background}`,
    `--surface:${colors.surface}`,
    `--border:${colors.border}`,
    `--text:${colors.text}`,
    `--muted:${colors.textMuted}`,
    `--primary:${colors.primary}`,
    `--warn-bg:${colors.warningSoft}`,
    `--warn:${colors.warning}`,
  ].join(';');
}

const STYLE = `
:root{color-scheme:light dark;${palette(lightColors)}}
@media (prefers-color-scheme:dark){:root{${palette(darkColors)}}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 .5rem}
h2{font-size:1.2rem;line-height:1.3;margin:2rem 0 .5rem}
p,li,dd{margin:.5rem 0}
.muted{color:var(--muted)}
a{color:var(--primary)}
a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.draft{background:var(--warn-bg);color:var(--text);border:2px solid var(--warn);border-radius:.5rem;padding:.75rem 1rem;margin:1rem 0;font-weight:600}
dl{margin:.5rem 0;border:1px solid var(--border);border-radius:.5rem;background:var(--surface)}
dl>div{padding:.5rem 1rem;border-top:1px solid var(--border)}
dl>div:first-child{border-top:0}
dt{font-weight:600}
dd{margin:.15rem 0 0}
nav{display:flex;flex-wrap:wrap;gap:1rem;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--border)}
`;

function renderBlock(block: LegalDocument['sections'][number]['blocks'][number]): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${escapeHtml(block.text)}</p>`;
    case 'list':
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    case 'facts':
      return `<dl>${block.rows
        .map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`)
        .join('')}</dl>`;
  }
}

export type RenderOptions = {
  /** Defaults to LEGAL_REVIEWED. Only tests pass it. */
  reviewed?: boolean;
};

/** A complete HTML document for `doc`. */
export function renderLegalPage(doc: LegalDocument, options: RenderOptions = {}): string {
  const reviewed = options.reviewed ?? LEGAL_REVIEWED;
  const title = `${doc.title} | TrainHive`;
  const sections = doc.sections
    .map(
      (section) =>
        `<section id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.heading)}</h2>${section.blocks
          .map(renderBlock)
          .join('')}</section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(doc.title)}</h1>
<p class="muted">Version ${escapeHtml(doc.version)}, last updated ${escapeHtml(doc.lastUpdated)}</p>
${reviewed ? '' : `<p class="draft" role="note">${escapeHtml(DRAFT_BANNER_TEXT)}</p>`}
<p>${escapeHtml(doc.intro)}</p>
${sections}
<nav aria-label="Legal documents">
<a href="/">Open TrainHive</a>
<a href="/privacy.html">${escapeHtml(LEGAL_DOC_TITLES.privacy)}</a>
<a href="/terms.html">${escapeHtml(LEGAL_DOC_TITLES.terms)}</a>
</nav>
</main>
</body>
</html>
`;
}
