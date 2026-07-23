/**
 * Wire types that outlived their client.
 *
 * These were declared alongside the retired `lib/api/clients/*` BaseApi layer
 * (which talked to the obsolete api-worker). The clients are gone; these three
 * types are still imported — as `import type` only — by live components that
 * now fetch the same shapes from app-api.
 *
 * Fold each into the owning feature (or the shared schema package) when that
 * surface is next touched; nothing here is a client, only a shape.
 */

/** Payload of GET /api/invitations/:token — rendered by app/invite/accept. */
export interface InvitationDetails {
  workspaceId: string;
  workspaceName: string;
  role: string;
  expiresAt?: string;
  isExpired: boolean;
  isUsed: boolean;
  inviteeEmail: string;
  inviteeName: string;
}

/** Result of accepting an invitation. */
export interface AcceptInvitationResult {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

/** A stored file as returned by the files/storage surface. */
export interface FileResponse {
  id: string;
  fileKey: string;
  fileName: string;
  contentType: string;
  size: number;
  folder: string;
  url: string;
  entityType?: string;
  entityId?: string;
  description?: string;
  tags?: string;
  isPublic: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
