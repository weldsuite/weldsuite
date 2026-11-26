// Bundles the service into one file, dist/server.mjs, for the image
// (rust/Dockerfile --target collab-rooms): the room classes from the domain packages,
// with this service's runtime in place of the Workers-only modules.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Workers-only modules the room classes import, and what they are on Node. */
const replacements = {
  'cloudflare:workers': here('./src/runtime/cloudflare-workers.ts'),
};

/**
 * Global's worker toolkit goes with the workers (ADR OPS-025), so nothing
 * this service runs may import it: a room opens its tenant database through
 * its host (src/app.ts). The domain packages still depend on worker-kit for
 * the workers' side, so esbuild would find it; refuse it instead.
 */
const refused = /^@weldsuite\/worker-kit(\/|$)/;

await build({
  entryPoints: [here('./src/main.ts')],
  outfile: here('./dist/server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  // CommonJS dependencies (ws, postgres) call require() for Node's own modules.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Optional native speed-ups of ws, and drivers drizzle may name but never loads here.
  external: ['bufferutil', 'utf-8-validate', 'pg-native'],
  plugins: [
    {
      name: 'workers-runtime',
      setup(b) {
        const filter = new RegExp(`^(${Object.keys(replacements).map((k) => k.replace(/[/.:-]/g, '\\$&')).join('|')})$`);
        b.onResolve({ filter }, (args) => ({ path: replacements[args.path] }));
        b.onResolve({ filter: refused }, (args) => ({
          errors: [{ text: `${args.path}, imported by ${args.importer}: collab-rooms must not bundle @weldsuite/worker-kit` }],
        }));
      },
    },
  ],
  logLevel: 'warning',
});
console.log('built dist/server.mjs');
