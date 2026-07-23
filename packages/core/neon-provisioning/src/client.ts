/**
 * Neon REST API Client
 *
 * Thin wrapper around the official Neon TypeScript SDK
 * (`@neondatabase/api-client`) that manages projects, databases, roles, and
 * connections. The SDK is axios-based; we force its `fetch` adapter so it runs
 * inside Cloudflare Workers (where XMLHttpRequest / node:http are unavailable).
 *
 * The public surface (NeonClient, createNeonClient, the interfaces below, and
 * NeonApiError) is kept byte-for-byte compatible with the previous hand-rolled
 * fetch client so callers in `provisioning.ts` and the workspace-worker need no
 * changes.
 *
 * SDK: https://neon.com/docs/reference/typescript-sdk
 * API: https://api-docs.neon.tech/reference/getting-started-with-neon-api
 */

import { createApiClient } from '@neondatabase/api-client';

type NeonApi = ReturnType<typeof createApiClient>;

export interface NeonApiConfig {
  apiKey: string;
  orgId?: string;
  defaultRegion?: string;
}

export interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  created_at: string;
  updated_at: string;
  pg_version: number;
  org_id?: string;
}

export interface NeonBranch {
  id: string;
  project_id: string;
  name: string;
  current_state: string;
  created_at: string;
  updated_at: string;
}

export interface NeonDatabase {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

export interface NeonRole {
  branch_id: string;
  name: string;
  password?: string;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface NeonEndpoint {
  id: string;
  host: string;
  project_id: string;
  branch_id: string;
  type: 'read_write' | 'read_only';
  current_state: string;
  pooler_enabled: boolean;
  pooler_mode: 'transaction' | 'session';
}

export interface NeonConnectionUri {
  connection_uri: string;
  connection_parameters: {
    database: string;
    host: string;
    password: string;
    role: string;
    pooler_host?: string;
  };
}

export interface CreateProjectResponse {
  project: NeonProject;
  branch: NeonBranch;
  endpoints: NeonEndpoint[];
  roles: NeonRole[];
  databases: NeonDatabase[];
  connection_uris: NeonConnectionUri[];
}

export interface CreateDatabaseResponse {
  database: NeonDatabase;
  operations: { id: string; action: string; status: string }[];
}

export interface CreateRoleResponse {
  role: NeonRole;
  operations: { id: string; action: string; status: string }[];
}

export interface GetConnectionUriResponse {
  uri: string;
}

export class NeonApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = 'NeonApiError';
  }
}

/**
 * Normalize any error thrown by the SDK (axios rejections on non-2xx, network
 * failures) into a NeonApiError, preserving the previous client's error shape.
 * Duck-typed so we don't need a direct `axios` dependency in this package.
 */
function toNeonApiError(error: unknown): NeonApiError {
  const err = error as {
    response?: { status?: number; data?: { message?: string; code?: string } };
    message?: string;
    status?: number;
  };
  const status = err?.response?.status ?? err?.status ?? 500;
  const data = err?.response?.data;
  const message =
    (typeof data?.message === 'string' && data.message) ||
    err?.message ||
    `Neon API error: ${status}`;
  return new NeonApiError(message, status, data?.code);
}

/**
 * Neon API Client
 */
export class NeonClient {
  private api: NeonApi;
  private orgId?: string;
  private defaultRegion: string;

  constructor(config: NeonApiConfig) {
    this.orgId = config.orgId;
    this.defaultRegion = config.defaultRegion || 'aws-eu-central-1';
    this.api = createApiClient({
      apiKey: config.apiKey,
      // Force axios onto its fetch adapter — the default xhr/http adapters
      // don't exist in the Cloudflare Workers runtime.
      adapter: 'fetch',
    });
  }

  /** Run an SDK call and unwrap the axios response body, mapping errors. */
  private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    try {
      const res = await fn();
      return res.data;
    } catch (error) {
      throw toNeonApiError(error);
    }
  }

  // ============================================================================
  // PROJECT MANAGEMENT
  // ============================================================================

  /**
   * Create a new dedicated Neon project
   *
   * @param name - Project name (e.g., "weldsuite-ws-abc123")
   * @param region - Region ID (default: aws-eu-central-1)
   * @param options - Optional settings (some require paid Neon plans)
   */
  async createProject(
    name: string,
    region?: string,
    options?: {
      // These settings require Neon paid plans
      autoscalingLimitMinCu?: number;
      autoscalingLimitMaxCu?: number;
      suspendTimeoutSeconds?: number;
    }
  ): Promise<CreateProjectResponse> {
    const projectConfig: Record<string, unknown> = {
      name,
      region_id: region || this.defaultRegion,
      pg_version: 16,
    };

    // Only add endpoint settings if explicitly provided (requires paid plan)
    if (options?.autoscalingLimitMinCu !== undefined ||
        options?.autoscalingLimitMaxCu !== undefined ||
        options?.suspendTimeoutSeconds !== undefined) {
      projectConfig.default_endpoint_settings = {
        ...(options.autoscalingLimitMinCu !== undefined && { autoscaling_limit_min_cu: options.autoscalingLimitMinCu }),
        ...(options.autoscalingLimitMaxCu !== undefined && { autoscaling_limit_max_cu: options.autoscalingLimitMaxCu }),
        ...(options.suspendTimeoutSeconds !== undefined && { suspend_timeout_seconds: options.suspendTimeoutSeconds }),
      };
    }

    // If org ID is set, create project in the organization
    if (this.orgId) {
      projectConfig.org_id = this.orgId;
    }

    const data = await this.call((): Promise<{ data: CreateProjectResponse }> =>
      this.api.createProject({ project: projectConfig } as never) as never
    );
    return data;
  }

  /**
   * Get project details
   */
  async getProject(projectId: string): Promise<{ project: NeonProject }> {
    return this.call((): Promise<{ data: { project: NeonProject } }> =>
      this.api.getProject(projectId) as never
    );
  }

  /**
   * Delete a Neon project
   */
  async deleteProject(projectId: string): Promise<void> {
    await this.call(() => this.api.deleteProject(projectId));
  }

  /**
   * List all projects
   */
  async listProjects(): Promise<{ projects: NeonProject[] }> {
    return this.call((): Promise<{ data: { projects: NeonProject[] } }> =>
      this.api.listProjects(this.orgId ? { org_id: this.orgId } : {}) as never
    );
  }

  // ============================================================================
  // BRANCH MANAGEMENT
  // ============================================================================

  /**
   * Get the main branch for a project
   */
  async getMainBranch(projectId: string): Promise<NeonBranch> {
    const { branches } = await this.listBranches(projectId);
    const mainBranch = branches.find(b => b.name === 'main');
    if (!mainBranch) {
      throw new NeonApiError('Main branch not found', 404);
    }
    return mainBranch;
  }

  /**
   * List all branches for a project
   */
  async listBranches(projectId: string): Promise<{ branches: NeonBranch[] }> {
    return this.call((): Promise<{ data: { branches: NeonBranch[] } }> =>
      this.api.listProjectBranches({ projectId }) as never
    );
  }

  // ============================================================================
  // DATABASE MANAGEMENT
  // ============================================================================

  /**
   * Create a new database within a project/branch
   *
   * @param projectId - Neon project ID
   * @param branchId - Branch ID (usually main branch)
   * @param name - Database name (e.g., "ws_abc123" for free tier)
   * @param ownerName - Role that owns this database
   */
  async createDatabase(
    projectId: string,
    branchId: string,
    name: string,
    ownerName: string
  ): Promise<CreateDatabaseResponse> {
    return this.call((): Promise<{ data: CreateDatabaseResponse }> =>
      this.api.createProjectBranchDatabase(projectId, branchId, {
        database: { name, owner_name: ownerName },
      }) as never
    );
  }

  /**
   * Get database details
   */
  async getDatabase(
    projectId: string,
    branchId: string,
    databaseName: string
  ): Promise<{ database: NeonDatabase }> {
    return this.call((): Promise<{ data: { database: NeonDatabase } }> =>
      this.api.getProjectBranchDatabase(projectId, branchId, databaseName) as never
    );
  }

  /**
   * Delete a database
   */
  async deleteDatabase(
    projectId: string,
    branchId: string,
    databaseName: string
  ): Promise<void> {
    await this.call(() =>
      this.api.deleteProjectBranchDatabase(projectId, branchId, databaseName)
    );
  }

  /**
   * List all databases in a branch
   */
  async listDatabases(
    projectId: string,
    branchId: string
  ): Promise<{ databases: NeonDatabase[] }> {
    return this.call((): Promise<{ data: { databases: NeonDatabase[] } }> =>
      this.api.listProjectBranchDatabases(projectId, branchId) as never
    );
  }

  // ============================================================================
  // ROLE MANAGEMENT
  // ============================================================================

  /**
   * Create a new role within a project/branch
   *
   * @param projectId - Neon project ID
   * @param branchId - Branch ID
   * @param name - Role name (e.g., "role_ws_abc123")
   */
  async createRole(
    projectId: string,
    branchId: string,
    name: string
  ): Promise<CreateRoleResponse> {
    return this.call((): Promise<{ data: CreateRoleResponse }> =>
      this.api.createProjectBranchRole(projectId, branchId, {
        role: { name },
      }) as never
    );
  }

  /**
   * Get role details (including password)
   */
  async getRole(
    projectId: string,
    branchId: string,
    roleName: string
  ): Promise<{ role: NeonRole }> {
    return this.call((): Promise<{ data: { role: NeonRole } }> =>
      this.api.getProjectBranchRole(projectId, branchId, roleName) as never
    );
  }

  /**
   * Get role password
   * Neon generates passwords for roles, this retrieves the current password
   */
  async getRolePassword(
    projectId: string,
    branchId: string,
    roleName: string
  ): Promise<{ password: string }> {
    return this.call((): Promise<{ data: { password: string } }> =>
      this.api.getProjectBranchRolePassword(projectId, branchId, roleName) as never
    );
  }

  /**
   * Delete a role
   */
  async deleteRole(
    projectId: string,
    branchId: string,
    roleName: string
  ): Promise<void> {
    await this.call(() =>
      this.api.deleteProjectBranchRole(projectId, branchId, roleName)
    );
  }

  /**
   * List all roles in a branch
   */
  async listRoles(
    projectId: string,
    branchId: string
  ): Promise<{ roles: NeonRole[] }> {
    return this.call((): Promise<{ data: { roles: NeonRole[] } }> =>
      this.api.listProjectBranchRoles(projectId, branchId) as never
    );
  }

  // ============================================================================
  // OPERATIONS
  // ============================================================================

  /**
   * Get a single Neon operation's current state.
   */
  async getOperation(
    projectId: string,
    operationId: string
  ): Promise<{ operation: { id: string; status: string; error?: string } }> {
    return this.call((): Promise<{ data: { operation: { id: string; status: string; error?: string } } }> =>
      this.api.getProjectOperation(projectId, operationId) as never
    );
  }

  /**
   * Block until the given Neon operations finish.
   *
   * `createDatabase` / `createRole` (and other mutating calls) return operations
   * that are applied ASYNCHRONOUSLY on the compute. Connecting before they settle
   * yields "database/role does not exist" errors, so callers that immediately use
   * the new resource (e.g. building a connection URI and running migrations) must
   * await completion first.
   *
   * Throws on a failed/cancelled operation or when the timeout is exceeded.
   */
  async waitForOperations(
    projectId: string,
    operations: { id: string; status: string }[],
    opts: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    const terminalOk = new Set(['finished', 'skipped']);
    const terminalBad = new Set(['failed', 'error', 'cancelled', 'cancelling']);

    const pending = operations.filter((op) => !terminalOk.has(op.status)).map((op) => op.id);

    for (const operationId of pending) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { operation } = await this.getOperation(projectId, operationId);

        if (terminalOk.has(operation.status)) break;
        if (terminalBad.has(operation.status)) {
          throw new NeonApiError(
            `Neon operation ${operationId} ${operation.status}${operation.error ? `: ${operation.error}` : ''}`,
            500
          );
        }
        if (Date.now() > deadline) {
          throw new NeonApiError(`Timed out waiting for Neon operation ${operationId} (last status: ${operation.status})`, 504);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  // ============================================================================
  // ENDPOINT MANAGEMENT
  // ============================================================================

  /**
   * Get the read-write endpoint for a branch
   */
  async getEndpoint(projectId: string, branchId: string): Promise<NeonEndpoint> {
    const { endpoints } = await this.listEndpoints(projectId);

    const endpoint = endpoints.find(
      e => e.branch_id === branchId && e.type === 'read_write'
    );

    if (!endpoint) {
      throw new NeonApiError('Endpoint not found for branch', 404);
    }

    return endpoint;
  }

  /**
   * List all endpoints for a project
   */
  async listEndpoints(projectId: string): Promise<{ endpoints: NeonEndpoint[] }> {
    return this.call((): Promise<{ data: { endpoints: NeonEndpoint[] } }> =>
      this.api.listProjectEndpoints(projectId) as never
    );
  }

  // ============================================================================
  // CONNECTION URI
  // ============================================================================

  /**
   * Build a connection URI for a specific database and role
   *
   * @param projectId - Neon project ID
   * @param branchId - Branch ID
   * @param databaseName - Database name
   * @param roleName - Role name
   * @param options - Additional options
   */
  async getConnectionUri(
    projectId: string,
    branchId: string,
    databaseName: string,
    roleName: string,
    options: {
      pooled?: boolean;
      sslMode?: string;
    } = {}
  ): Promise<string> {
    const { pooled = true, sslMode = 'require' } = options;

    // Get endpoint for the branch
    const endpoint = await this.getEndpoint(projectId, branchId);

    // Get role password
    const { password } = await this.getRolePassword(projectId, branchId, roleName);

    // Build connection string
    // Pooled connections use a different host format: ep-xxx-pooler.region.aws.neon.tech
    let host = endpoint.host;
    if (pooled && endpoint.pooler_enabled) {
      // Neon pooler host is derived from endpoint host
      // ep-xxx.region.aws.neon.tech -> ep-xxx-pooler.region.aws.neon.tech
      host = host.replace(/^(ep-[^.]+)/, '$1-pooler');
    }

    const uri = `postgresql://${encodeURIComponent(roleName)}:${encodeURIComponent(password)}@${host}/${databaseName}?sslmode=${sslMode}`;

    return uri;
  }

  /**
   * Build a connection URI from known parts without making API calls.
   * Use this when you already have the host, role, password, and database name
   * (e.g., from cached shared project host + createRole response).
   */
  static buildConnectionUri(
    host: string,
    roleName: string,
    password: string,
    databaseName: string,
    options: { pooled?: boolean; sslMode?: string } = {}
  ): string {
    const { pooled = true, sslMode = 'require' } = options;

    let effectiveHost = host;
    if (pooled) {
      // Neon pooler host: ep-xxx.region.aws.neon.tech -> ep-xxx-pooler.region.aws.neon.tech
      effectiveHost = host.replace(/^(ep-[^.]+)/, '$1-pooler');
    }

    return `postgresql://${encodeURIComponent(roleName)}:${encodeURIComponent(password)}@${effectiveHost}/${databaseName}?sslmode=${sslMode}`;
  }

  /**
   * Get connection details without building full URI
   */
  async getConnectionDetails(
    projectId: string,
    branchId: string,
    roleName: string
  ): Promise<{
    host: string;
    poolerHost: string;
    port: number;
    password: string;
    sslMode: string;
  }> {
    const endpoint = await this.getEndpoint(projectId, branchId);
    const { password } = await this.getRolePassword(projectId, branchId, roleName);

    const poolerHost = endpoint.host.replace(/^(ep-[^.]+)/, '$1-pooler');

    return {
      host: endpoint.host,
      poolerHost,
      port: 5432,
      password,
      sslMode: 'require',
    };
  }
}

/**
 * Create a Neon client from environment variables
 */
export function createNeonClient(env: {
  NEON_API_KEY: string;
  NEON_ORG_ID?: string;
  NEON_DEFAULT_REGION?: string;
}): NeonClient {
  return new NeonClient({
    apiKey: env.NEON_API_KEY,
    orgId: env.NEON_ORG_ID,
    defaultRegion: env.NEON_DEFAULT_REGION || 'aws-eu-central-1',
  });
}
