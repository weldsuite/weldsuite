/**
 * Widget Attachments Routes
 *
 * Handles file uploads for chat attachments via R2 binding.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../index';
import { success, error } from '../lib/response';
import { generateId } from '../lib/id';
import { publishEntityEvent } from '../lib/entity-events';

// Allowed file types for attachments
const ALLOWED_TYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const attachmentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /upload - Upload a file attachment
 *
 * Accepts multipart form data with:
 * - file: The file to upload
 * - conversationId: Optional conversation ID for organization
 *
 * Returns the uploaded file's metadata and public URL.
 */
attachmentsRoutes.post('/upload', async (c) => {
  const workspaceId = c.get('workspaceId');

  // Check if R2 storage is configured
  if (!c.env.STORAGE) {
    console.error('[Widget] R2 storage binding not configured');
    return error.internal(c, 'File upload not available');
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const conversationId = formData.get('conversationId') as string | null;

    if (!file) {
      return error.badRequest(c, 'No file provided');
    }

    if (file.size > MAX_FILE_SIZE) {
      return error.badRequest(c, 'File too large (max 10MB)');
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return error.badRequest(c, `File type not allowed: ${file.type}`);
    }

    // Generate unique file key with workspace scoping
    const attachmentId = generateId('att');
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const fileKey = `widgets/${workspaceId}/${conversationId || 'general'}/${timestamp}_${attachmentId}_${sanitizedName}`;

    // Upload to R2 using binding
    const arrayBuffer = await file.arrayBuffer();
    await c.env.STORAGE.put(fileKey, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Generate public URL
    const publicUrl = c.env.R2_PUBLIC_URL
      ? `${c.env.R2_PUBLIC_URL}/${fileKey}`
      : `https://weldsuite-storage-test.weldsuite.org/${fileKey}`;

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
        conversationId: conversationId || null,
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
