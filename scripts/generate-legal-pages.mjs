/**
 * Generates the static legal pages of the web version (public/privacy.html and
 * public/terms.html) from the same content modules the app uses.
 *
 *   npm run legal:build                  (set the EXPO_PUBLIC_CONTROLLER_* variables first)
 *
 * The controller's name, address and privacy e-mail are read from the environment
 * (and from .env.local / .env, never overriding variables that are already set).
 * When they are missing the pages show the marker [TO BE FILLED]. The generated
 * files contain personal details when you set them: they are git-ignored, so never
 * commit them. Run this before `expo export --platform web` (see docs/WEB_DEPLOY.md).
 *
 * Options:  --out <dir>        output directory (default: public)
 *           --no-env-files     do not read .env.local / .env (used by the tests)
 *
 * Needs Node 22.18 or newer (built-in TypeScript type stripping). Prints file names
 * only, never the configured values.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.features.typescript) {
  console.error('legal:build needs Node 22.18 or newer (TypeScript type stripping). Update Node and try again.');
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(root, outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : 'public');

if (!args.includes('--no-env-files')) {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

const hooks = await import('./ts-extensionless-hooks.mjs');
if (typeof nodeModule.registerHooks === 'function') nodeModule.registerHooks({ resolve: hooks.resolveSync });
else nodeModule.register('./ts-extensionless-hooks.mjs', import.meta.url);

const legalDir = pathToFileURL(path.join(root, 'src', 'features', 'legal')).href;
const { legalConfig } = await import(`${legalDir}/config.ts`);
const { buildLegalDocument } = await import(`${legalDir}/content/index.ts`);
const { renderLegalPage } = await import(`${legalDir}/domain/renderHtml.ts`);
const { LEGAL_DOC_KINDS } = await import(`${legalDir}/constants.ts`);

mkdirSync(outDir, { recursive: true });
const written = [];
for (const kind of LEGAL_DOC_KINDS) {
  const file = path.join(outDir, `${kind}.html`);
  writeFileSync(file, renderLegalPage(buildLegalDocument(kind, legalConfig)), 'utf8');
  written.push(path.relative(root, file));
}

console.log(`Wrote ${written.join(' and ')}.`);
if (!legalConfig.legalDetailsComplete) {
  console.log(
    'Warning: the controller name, address or privacy e-mail is not set, so the pages show [TO BE FILLED]. ' +
      'Set EXPO_PUBLIC_CONTROLLER_NAME, EXPO_PUBLIC_CONTROLLER_ADDRESS and EXPO_PUBLIC_PRIVACY_EMAIL and run this again.',
  );
}
