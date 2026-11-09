import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'vite'

const VIRTUAL_ID = 'virtual:forms-embed'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const SDK_ROOT = fileURLToPath(new URL('../../../../packages/sdk/forms-embed', import.meta.url))

/** Builds the SDK entry into one minified IIFE, in memory (the same build as the package's own `pnpm build`). */
async function bundleSdk(): Promise<string> {
  const result = await build({
    root: SDK_ROOT,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2019',
      lib: {
        entry: fileURLToPath(new URL('src/embed-entry.ts', `${pathToFileURL(SDK_ROOT).href}/`)),
        formats: ['iife'],
        name: 'WeldForms',
        fileName: () => 'embed.js',
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []))
  const chunk = outputs.find((o) => o.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk') throw new Error('forms-embed: the SDK build produced no script')
  return chunk.code
}

/**
 * `import source from 'virtual:forms-embed'` is the embed SDK as a string.
 * forms-portal serves it at /embed.js (src/routes/embed[.]js.ts). Building it
 * here, from source, means the portal and the SDK can never drift apart: no
 * separate build step to run first, no committed artifact.
 */
export function formsEmbed(): Plugin {
  let cached: Promise<string> | null = null
  return {
    name: 'weldforms-embed',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined
      cached ??= bundleSdk()
      return `export default ${JSON.stringify(await cached)}`
    },
  }
}
