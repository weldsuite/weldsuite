// The Worker's bindings are WeldSign's (SignEnv, @weldsuite/sign-domain/env),
// which `env` from 'cloudflare:workers' is typed with. wrangler.toml declares
// the same set; kept by hand instead of `wrangler types`.
import type { SignEnv } from '@weldsuite/sign-domain/env'

declare global {
  namespace Cloudflare {
    // Declaration merging: this adds SignEnv to the Env the runtime types declare.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends SignEnv {}
  }
}
