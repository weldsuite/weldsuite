// Bundles the service into one file, dist/server.mjs, for the image
// (rust/Dockerfile --target collab-rooms): the room classes from the workers,
// with this service's runtime in place of the Workers-only modules.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Workers-only modules the room classes import, and what they are on Node. */
const replacements = {
  'cloudflare:workers': here('./src/runtime/cloudflare-workers.ts'),
  '@weldsuite/worker-kit/db': here('./src/runtime/tenant-db.ts'),
};

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
      },
    },
  ],
  logLevel: 'warning',
});
console.log('built dist/server.mjs');
