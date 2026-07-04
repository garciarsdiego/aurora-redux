// REPL bundle config (D-H2.031). The rest of the codebase keeps tsc-only output;
// this bundles ONLY src/repl/ into dist/repl/bundle.mjs to slash cold start
// (480ms → 210ms) by collapsing 47 transitive imports (React + Ink + reconciler
// + yoga) into a single ESM file.
//
// Externals:
//   - better-sqlite3 / fsevents: native bindings, can't be bundled.
//   - yoga-wasm-web: ~600KB WASM blob, lazy-loaded via createRequire at runtime
//     to keep the bundle under the 2.5MB target.
//
// Source maps: separate file in release (not inline) to keep distributable size
// small but still allow stack traces to point to real source.

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'repl/bundle': 'src/repl/index.tsx' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  treeshake: true,
  minify: false,
  sourcemap: true,
  clean: false, // tsc owns dist/ cleanup; we coexist
  // Shims add `createRequire` and `__dirname/__filename` for CJS-interop
  // packages (signal-exit, etc.) that use `require()` inside an ESM bundle.
  // Without this, dynamic `require('assert')` calls throw at runtime.
  shims: true,
  external: [
    'better-sqlite3',
    'fsevents',
    'yoga-wasm-web',
    // Node core builtins
    'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http',
    'https', 'net', 'os', 'path', 'process', 'readline', 'stream', 'string_decoder',
    'tls', 'tty', 'url', 'util', 'v8', 'vm', 'zlib', 'worker_threads',
    'node:assert', 'node:buffer', 'node:child_process', 'node:crypto', 'node:events',
    'node:fs', 'node:fs/promises', 'node:http', 'node:https', 'node:net', 'node:os',
    'node:path', 'node:process', 'node:readline', 'node:stream', 'node:string_decoder',
    'node:tls', 'node:tty', 'node:url', 'node:util', 'node:v8', 'node:vm',
    'node:zlib', 'node:worker_threads',
    // (Externals for non-repl siblings are handled by the plugin below so we
    // can check args.importer — `../utils/` from inside src/repl/ resolves
    // to src/repl/utils/, NOT src/utils/, and must stay bundled.)
  ],
  // MA: keep Ink+React+companions EXTERNAL — bundling them in ESM requires
  // shimming a tangle of CJS requires (signal-exit's require('assert'), etc).
  // Cold start temporarily regresses from 210ms target to ~480ms; the bundle
  // wins (270ms gain) come back in ME after we either:
  //   (a) Ink ships fully ESM (waiting on upstream), or
  //   (b) we ship a custom esbuild plugin that rewrites CJS requires.
  // For MA the priority is "REPL works", not "fastest cold start".
  noExternal: [],
  esbuildOptions(options) {
    options.conditions = ['node'];
    // Ink imports react-devtools-core for dev UX. The REPL never enables
    // devtools, so we alias the module to a tiny stub instead of installing
    // the 30MB optional dep. The stub throws if invoked (should never fire).
    options.alias = {
      ...(options.alias ?? {}),
      'react-devtools-core': './src/repl/stubs/react-devtools-core.js',
    };
    // CRITICAL: externalize ANY relative import that escapes src/repl/.
    // tsup's `external` array doesn't accept regexes for relative paths,
    // so we register a high-priority esbuild plugin (namespace 'file' so it
    // runs on file resolution, before path normalization).
    // CRITICAL: externalize imports that ESCAPE src/repl/. We can only know
    // this by inspecting args.importer (vs the import path alone, which would
    // also catch internal `../utils/redaction.js` from src/repl/state/).
    const NON_REPL_AREAS = new Set([
      'db', 'brain', 'utils', 'mcp', 'v2', 'executors',
      'patterns', 'hitl', 'reviewer', 'types',
    ]);
    options.plugins = [
      {
        name: 'externalize-non-repl-by-importer',
        setup(build) {
          build.onResolve({ filter: /^\.\./ }, (args) => {
            // Importer is the source file. If the relative path traverses
            // up OUT of src/repl/, externalize it.
            // Compute resolved target: importer dir + path.
            // Quick heuristic: if importer ends with /src/repl/<file>.ts,
            // then `../X/` means src/X/ (escapes src/repl/).
            // If importer is src/repl/<sub>/<file>.ts, `../X/` stays inside src/repl/.
            const importer = args.importer.replace(/\\/g, '/');
            const inReplRoot = /\/src\/repl\/[^/]+$/.test(importer);
            if (!inReplRoot) return undefined; // sub-dirs: let bundle inline
            // Path starts with `../<area>/`. If <area> is a known non-repl
            // sibling, externalize.
            const m = args.path.match(/^\.\.\/([^/]+)\//);
            if (m && NON_REPL_AREAS.has(m[1])) {
              return { path: args.path, external: true };
            }
            return undefined;
          });
        },
      },
      ...(options.plugins ?? []),
    ];
  },
});
