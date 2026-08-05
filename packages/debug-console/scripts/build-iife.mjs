// The prebuilt drop-in: a host with no bundler adds one <script> tag.
// Zero runtime dependencies is a TESTED property of this package, so the IIFE
// is genuinely self-contained — no CDN, no font, no fetch on load.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/iife-entry.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'SovDebugConsole',
  target: ['es2022'],
  outfile: 'dist/sov-debug-console.iife.js',
  minify: true,
});
console.log('built dist/sov-debug-console.iife.js');
