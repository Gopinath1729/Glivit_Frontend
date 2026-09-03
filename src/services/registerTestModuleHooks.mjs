import { register } from 'node:module';

/**
 * Installs {@link ./testModuleHooks.mjs} for a `node --test` run.
 *
 * Used as `node --import ./src/services/registerTestModuleHooks.mjs ...` so the
 * hooks are in place before any test file is loaded. Test-only.
 */
register('./testModuleHooks.mjs', import.meta.url);
