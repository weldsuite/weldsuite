/**
 * Widget Attachments Routes
 *
 * Handles file uploads for chat attachments via R2 binding.
 *
 * The upload is tied to a conversation the calling visitor owns (same rule as
 * the conversation routes), and only passive file types are accepted: the
 * object is served from the public bucket domain, so a stored SVG or HTML file
 * would run script on that host.
 */

import { Hono } from 'hono';
import { getDeskConversation } from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../index';
import { success, error } from '../lib/response';
import { generateId } from '../lib/id';
import { publishEntityEvent } from '../lib/entity-events';
import { publicAttachmentUrl, publicStorageBase } from '../lib/attachments';

// Allowed file types for attachments. No SVG: it is a document that can carry script.
const ALLOWED_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Visitor ids and conversation ids are interpolated into the R2 key. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const attachmentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /upload - Upload a file attachment
 *
 * Accepts multipart form data with:
 * - file: The file to upload
 * - conversationId: The conversation the file belongs to
 * - visitorId: The calling visitor; must own the conversation
 *
 * Returns the uploaded file's metadata and public URL.
 */
attachmentsRoutes.post('/upload', async (c) => {
  const workspaceId = c.get('clerkOrgId');

  // Check if R2 storage is configured
  if (!c.env.STORAGE) {
    console.error('[Widget] R2 storage binding not configured');
    return error.internal(c, 'File upload not available');
  }
  // No fallback host: a worker without a public bucket URL must not hand out
  // links into another environment's bucket.
  if (!publicStorageBase(c.env)) {
    console.error('[Widget] R2_PUBLIC_URL not configured');
    return error.internal(c, 'File upload not available');
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | string | null;
    const conversationId = formData.get('conversationId');
    const visitorId = formData.get('visitorId');

    if (!file || typeof file === 'string') {
      return error.badRequest(c, 'No file provided');
    }
    if (typeof conversationId !== 'string' || !ID_PATTERN.test(conversationId)) {
      return error.badRequest(c, 'conversationId is required');
    }
    if (typeof visitorId !== 'string' || !ID_PATTERN.test(visitorId)) {
      return error.badRequest(c, 'visitorId is required');
    }

    const owned = await getDeskConversation(c.get('tenantDb'), conversationId);
    if (!owned || owned.conversation.visitorId !== visitorId) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    if (file.size > MAX_FILE_SIZE) {
      return error.badRequest(c, 'File too large (max 10MB)');
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return error.badRequest(c, `File type not allowed: ${file.type}`);
    }

    // Generate unique file key with workspace scoping
    const attachmentId = generateId('att');
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const fileKey = `widgets/${workspaceId}/${conversationId}/${timestamp}_${attachmentId}_${sanitizedName}`;

    // Upload to R2 using binding
    const arrayBuffer = await file.arrayBuffer();
    await c.env.STORAGE.put(fileKey, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Generate public URL
    const publicUrl = publicAttachmentUrl(c.env, fileKey);
    if (!publicUrl) return error.internal(c, 'File upload not available');

    console.log(`[Widget] Uploaded attachment ${attachmentId} to ${fileKey}`);

    // Publish entity event for attachment creation
    publishEntityEvent({
      c,
      entityType: 'helpdesk_attachment',
      entityId: attachmentId,
      action: 'created',
      data: {
        id: attachmentId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        url: publicUrl,
        fileKey,
        conversationId,
      },
    });

    return success(c, {
      id: attachmentId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      url: publicUrl,
      fileKey,
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to upload attachment:', err);
    return error.internal(c, 'Failed to upload attachment');
  }
});
