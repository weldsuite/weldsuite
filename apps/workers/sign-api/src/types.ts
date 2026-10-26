import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { SignEnv } from '@weldsuite/sign-domain/env';

/**
 * sign-api bindings: the kit's (auth, tenant DB, flags) plus WeldSign's own,
 * which live in @weldsuite/sign-domain because apps/web/sign-portal runs the
 * same domain code. Add a binding there and in wrangler.toml together.
 */
export interface Env extends KitEnv, SignEnv {
  ENVIRONMENT: string;
}

export type Variables = KitVariables;
