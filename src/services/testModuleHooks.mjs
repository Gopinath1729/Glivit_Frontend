import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Resolution hooks that let plain `node --test` load this app's source.
 *
 * Metro and TypeScript both resolve extensionless imports and the `@/` project
 * alias; bare Node resolves neither, so a service module could only be unit
 * tested if it happened to import nothing. That is why the GPS pipeline's
 * hardest logic had no tests - not because it was untestable, but because the
 * runner could not load it.
 *
 * Test-only. Nothing in the app imports this.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];

function firstExisting(basePath) {
  if (path.extname(basePath) && existsSync(basePath)) return basePath;
  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  let basePath = null;

  if (specifier.startsWith('@/')) {
    basePath = path.join(projectRoot, specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : projectRoot;
    basePath = path.resolve(parent, specifier);
  }

  if (basePath) {
    const resolved = firstExisting(basePath);
    if (resolved) {
      // No `format`: Node infers it from the extension, which is what selects
      // its TypeScript type-stripping loader for a `.ts` file. Forcing
      // 'module' here hands raw TypeScript to the JavaScript parser instead.
      return { shortCircuit: true, url: pathToFileURL(resolved).href };
    }
  }

  return nextResolve(specifier, context);
}
