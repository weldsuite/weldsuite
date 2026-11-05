/**
 * OAuth and token connections: /api/merge/connections/:provider/*.
 *
 *   GET  /:provider/authorize-url?returnTo=   -> { url }: the consent page (gitlab, bitbucket, azure_devops)
 *   POST /gitlab {host, token}                -> a self-managed GitLab connection, token validated with GET {host}/api/v4/user
 *   POST /azure_devops/organization           -> choose the organisation of an Azure DevOps connection (when the member has several)
 *
 * All need merge_connections:manage. The credentials are stored sealed and never
 * returned; the entity events carry the provider and account login only.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import {
  MERGE_OAUTH_CONNECTION_PROVIDERS,
  mergeAuthorizeUrlQuerySchema,
  mergeAzureOrganizationSchema,
  mergeGitlabTokenSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import type { Env, Variables } from '../../types';
import { providerFailure, unprocessable, type Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { connectionDto } from '../../services/mappers';
import { findConnection, repositoryCount } from '../../services/connections';
import { buildAuthorizeUrl } from '../../services/oauth/authorize';
import { setAzureOrganization } from '../../services/oauth/connections';
import { connectGitlabWithToken } from '../../services/oauth/gitlab-token';
import type { MergeConnectionRow } from '../../services/db';
import { connectionEventData } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const isConnectionProvider = (value: string): value is (typeof MERGE_OAUTH_CONNECTION_PROVIDERS)[number] =>
  (MERGE_OAUTH_CONNECTION_PROVIDERS as readonly string[]).includes(value);

function publishConnection(c: Ctx, connection: MergeConnectionRow, action: 'created' | 'updated') {
  publishEntityEvents(c, [{ entityType: 'merge_connection', action, entityId: connection.id, data: connectionEventData(connection) }]);
}

app.get('/:provider/authorize-url', requirePermission('merge_connections:manage'), zValidator('query', mergeAuthorizeUrlQuerySchema), async (c) => {
  const provider = c.req.param('provider');
  if (!isConnectionProvider(provider)) return error.notFound(c, 'Provider', provider);
  try {
    const result = await buildAuthorizeUrl(c.env, {
      provider,
      purpose: 'connection',
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      returnTo: c.req.valid('query').returnTo,
    });
    if (!result.ok) return unprocessable(c, 'Self-managed GitLab connects with an access token');
    return success(c, { url: result.url });
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.post('/gitlab', requirePermission('merge_connections:manage'), zValidator('json', mergeGitlabTokenSchema), async (c) => {
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  try {
    const result = await connectGitlabWithToken(db, c.env, c.get('userId'), input.host, input.token);
    if (!result.ok) return unprocessable(c, result.message);
    publishConnection(c, result.connection, result.created ? 'created' : 'updated');
    return success(c, connectionDto(result.connection, await repositoryCount(db, result.connection.id)), result.created ? 201 : 200);
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.post('/azure_devops/organization', requirePermission('merge_connections:manage'), zValidator('json', mergeAzureOrganizationSchema), async (c) => {
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  const connection = await findConnection(db, input.connectionId);
  if (!connection || connection.provider !== 'azure_devops') return error.notFound(c, 'Connection', input.connectionId);
  try {
    const result = await setAzureOrganization(db, c.env, connection, input.organization);
    if (!result.ok) {
      if (result.reason === 'organization_taken') return error.conflict(c, 'This organisation is already connected');
      return unprocessable(c, 'Azure DevOps does not give this account access to that organisation');
    }
    publishConnection(c, result.connection, 'updated');
    return success(c, connectionDto(result.connection, await repositoryCount(db, result.connection.id)));
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
