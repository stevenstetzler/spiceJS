/**
 * Bundles src/browser.js (the Node-free entry point -- see
 * docs/browser-support.md) into drop-in browser builds, for anyone who
 * wants spiceJS with no npm install/bundler step of their own -- just
 * a `<script>` tag pointed at a release asset. Two output shapes, both
 * minified with a source map:
 *
 *   dist/spicejs.esm.min.js    -- ES module: `import { load } from './spicejs.esm.min.js'`
 *   dist/spicejs.global.min.js -- plain global: `<script src="...">`,
 *                                  everything src/browser.js exports
 *                                  lands on `window.spicejs`
 *
 * Not committed to git (see .gitignore) -- built fresh by `npm run
 * build` (locally, for a quick check), test/dist.test.js (as part of
 * `npm test` -- a smoke test of the real built output, not just
 * src/browser.js directly), or `.github/workflows/release.yml` (on a
 * version-tag push, which is what actually ships these as GitHub
 * Release assets -- see that workflow for the real pipeline).
 *
 * Usage: node scripts/build.mjs
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'browser.js');
const OUT_DIR = path.join(REPO_ROOT, 'dist');

const shared = {
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  target: 'es2022',
  // Nothing here should ever touch a Node builtin (that's exactly what
  // src/browser.js exists to guarantee -- see its own doc comment and
  // test/browser.test.js) -- fail loudly at build time instead of
  // silently shipping a broken bundle if that ever stops being true.
  external: ['node:*'],
};

const builds = [
  {
    ...shared,
    format: 'esm',
    outfile: path.join(OUT_DIR, 'spicejs.esm.min.js'),
  },
  {
    ...shared,
    format: 'iife',
    globalName: 'spicejs',
    outfile: path.join(OUT_DIR, 'spicejs.global.min.js'),
  },
];

for (const options of builds) {
  const result = await esbuild.build({ ...options, metafile: true });
  const outPath = path.relative(REPO_ROOT, options.outfile);
  const bytes = result.metafile.outputs[path.relative(REPO_ROOT, options.outfile).replace(/\\/g, '/')]?.bytes;
  console.log(`built ${outPath}${bytes !== undefined ? ` (${(bytes / 1024).toFixed(1)} KiB)` : ''}`);
}
