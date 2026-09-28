/**
 * GitHub integration routes for WeldConnect — mounted at /api/workflow-github.
 *
 * NOTE: The public GitHub App OAuth callback (post-install redirect) is NOT
 * moved as part of this PR — it still lives in core-api at
 * `core-api.weldsuite.org/api/weldconnect/github/callback`. Re-pointing the
 * callback at app-api requires updating the GitHub App configuration with
 * GitHub itself, which is a coordinated deploy outside the scope of the
 * automated migration.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { githubInstallRoutes } from './install';
import { githubReposRoutes } from './repos';
import { githubSyncRoutes } from './sync';
import { githubProjectsRoutes } from './projects';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route('/', githubInstallRoutes);
app.route('/', githubReposRoutes);
app.route('/', githubSyncRoutes);
app.route('/', githubProjectsRoutes);

export const workflowGithubRoutes = app;
