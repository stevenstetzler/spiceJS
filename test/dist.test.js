/**
 * A real smoke test of the *built* browser bundles (scripts/build.mjs
 * -- see the release workflow, .github/workflows/release.yml), not
 * just src/browser.js directly: `npm test` alone (including in CI,
 * before this file existed) never actually loaded dist/spicejs.esm.min.js
 * or dist/spicejs.global.min.js and called anything on them, so an
 * esbuild misconfiguration -- or a Node builtin leaking back in despite
 * `external: ['node:*']` -- could ship a broken bundle with every
 * other test still green. See #13.
 *
 * Builds fresh in test.before() (esbuild is fast, well under a second)
 * rather than assuming dist/ is already there and current -- this way
 * `npm test` alone, from a clean clone with no separate `npm run build`
 * step first, still exercises the real thing `npm run build` produces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as browserEntry from '../src/browser.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const ESM_PATH = path.join(DIST_DIR, 'spicejs.esm.min.js');
const GLOBAL_PATH = path.join(DIST_DIR, 'spicejs.global.min.js');
const LSK_PATH = path.join(REPO_ROOT, 'kernels', 'naif0012.tls');

test.before(() => {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' });
});

// A static check on top of esbuild's own `external: ['node:*']`
// (scripts/build.mjs) -- that config stops esbuild from *bundling*
// node:fs/node:path, but wouldn't itself catch a stray literal
// `require(...)` call some future change introduced by hand. Checked
// against both files, not just the ESM one, since the two builds go
// through esbuild's `format: 'esm'`/`'iife'` paths independently.
test('neither built bundle references a Node builtin or require()', () => {
  for (const distPath of [ESM_PATH, GLOBAL_PATH]) {
    const code = fs.readFileSync(distPath, 'utf8');
    assert.doesNotMatch(code, /\bnode:(fs|path)\b/, `${path.basename(distPath)} references a Node builtin`);
    assert.doesNotMatch(code, /\brequire\(/, `${path.basename(distPath)} calls require()`);
  }
});

test('dist/spicejs.esm.min.js is a real, working ES module build', async () => {
  const mod = await import(pathToFileURL(ESM_PATH).href);

  // Same invariant test/browser.test.js checks against src/browser.js
  // directly -- checked here too since this is what actually ships;
  // a bundler dropping (or esbuild's minifier renaming instead of
  // just shortening) an export wouldn't be caught by that test alone.
  assert.deepEqual(Object.keys(mod).sort(), Object.keys(browserEntry).sort());

  const pool = new mod.KernelPool();
  const lsk = new Uint8Array(fs.readFileSync(LSK_PATH));
  await mod.load(lsk, pool);
  const et = mod.str2et('2026-08-11T12:00:00', pool);
  assert.equal(mod.et2utc(et, 3, pool), '2026-08-11T12:00:00.000');
});

test('dist/spicejs.global.min.js is a real, working global (window.spicejs) build', () => {
  const code = fs.readFileSync(GLOBAL_PATH, 'utf8');
  // A minimal stand-in for a browser's global object -- esbuild's iife
  // format assigns the bundle's exports onto `globalName` on whatever
  // object function calls without a receiver resolve to (`window` in a
  // real browser); `vm`'s own sandbox object plays that same role here.
  // vm's sandbox is a genuinely empty global scope, unlike a real
  // browser window -- it doesn't even inherit the calling process's
  // own TextDecoder/TextEncoder/fetch, all real browser globals this
  // bundle's code needs (TextDecoder for text-kernel decoding, fetch
  // for load()'s URL/lazy-loading paths).
  const sandbox = { TextDecoder, TextEncoder, fetch };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'spicejs.global.min.js' });

  assert.equal(typeof sandbox.spicejs, 'object');
  assert.deepEqual(Object.keys(sandbox.spicejs).sort(), Object.keys(browserEntry).sort());
});

test('dist/spicejs.global.min.js actually works end to end, not just exists', async () => {
  const code = fs.readFileSync(GLOBAL_PATH, 'utf8');
  // vm's sandbox is a genuinely empty global scope, unlike a real
  // browser window -- it doesn't even inherit the calling process's
  // own TextDecoder/TextEncoder/fetch, all real browser globals this
  // bundle's code needs (TextDecoder for text-kernel decoding, fetch
  // for load()'s URL/lazy-loading paths).
  const sandbox = { TextDecoder, TextEncoder, fetch };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'spicejs.global.min.js' });

  const pool = new sandbox.spicejs.KernelPool();
  const lsk = new Uint8Array(fs.readFileSync(LSK_PATH));
  await sandbox.spicejs.load(lsk, pool);
  const et = sandbox.spicejs.str2et('2026-08-11T12:00:00', pool);
  assert.equal(sandbox.spicejs.et2utc(et, 3, pool), '2026-08-11T12:00:00.000');
});
