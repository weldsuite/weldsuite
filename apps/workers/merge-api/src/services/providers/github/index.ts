/**
 * GitHub provider. `connection` wraps the App's REST client (connection.ts).
 * Area A adds `issues` (issues.ts, the two-way sync adapter); area B adds
 * `oauth` (oauth.ts, the App's user authorization); area C adds `review`
 * (review.ts).
 */

import type { ProviderModule } from '../types';
import { githubConnection } from './connection';

export const githubProvider: ProviderModule = {
  connection: githubConnection,
};
