/**
 * Module resolution hook for scripts/generate-legal-pages.mjs: the shared TypeScript
 * modules import each other without file extensions (as Metro and Vitest allow), but
 * Node's built-in type stripping needs a real file name. Tries `<specifier>.ts` for
 * extensionless relative imports and leaves everything else alone.
 */
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

function wantsTs(specifier) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  return isRelative && !HAS_EXTENSION.test(specifier);
}

const notFound = (error) => error?.code === 'ERR_MODULE_NOT_FOUND';

/** For `module.register` (async hooks thread). */
export async function resolve(specifier, context, nextResolve) {
  if (wantsTs(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return nextResolve(specifier, context);
}

/** For `module.registerHooks` (in-thread, synchronous). */
export function resolveSync(specifier, context, nextResolve) {
  if (wantsTs(specifier)) {
    try {
      return nextResolve(`${specifier}.ts`, context);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return nextResolve(specifier, context);
}
