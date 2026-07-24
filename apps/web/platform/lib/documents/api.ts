/**
 * Neutral document API — app-api calls for any file-backed document, used by
 * the shared document editor across surfaces (WeldFlow, Weld Drive, the
 * full-screen route). Not tied to any single module.
 *
 * Content is BlockNote block JSON in the `docs` table (source of truth);
 * file metadata (name, folder, trash) lives on the `files` row. docx is a
 * derived/legacy artifact used only for the load fallback + download.
 */

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

async function authHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') {
    const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
    const token = clerk?.session ? await clerk.session.getToken() : null;
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/** Load the document's BlockNote blocks, or `null` if no `docs` row exists. */
async function fetchDocumentJson(fileId: string): Promise<Record<string, unknown>[] | null> {
  const res = await fetch(`${APP_API_URL}/api/documents/${fileId}`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
  const body = (await res.json()) as { data: { content?: Record<string, unknown>[] } | null };
  return body.data?.content ?? null;
}

/** Persist the document's BlockNote blocks. */
async function putDocumentJson(fileId: string, content: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${APP_API_URL}/api/documents/${fileId}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to save document (${res.status})`);
}

/** Legacy DOCX binary (R2) — used only as a load fallback for pre-Phase-1 docs. */
async function fetchDocumentDocx(fileId: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${APP_API_URL}/api/files/${fileId}/content`, { headers: await authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
  return res.arrayBuffer();
}

/** Create a standalone (drive) document. Returns the new file id. */
export async function createDocument(input: { name: string; folderId?: string | null }): Promise<string> {
  const res = await fetch(`${APP_API_URL}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ name: input.name, folderId: input.folderId ?? null }),
  });
  if (!res.ok) throw new Error(`Failed to create document (${res.status})`);
  const body = (await res.json()) as { data: { id: string } };
  return body.data.id;
}

// ---------------------------------------------------------------------------
// HTML document content (for the standalone contenteditable paginated editor).
// Stored in the same `content` column as a single `[{ html }]` entry.
// ---------------------------------------------------------------------------

export async function fetchDocumentHtml(fileId: string): Promise<string> {
  const content = await fetchDocumentJson(fileId);
  if (content && content.length > 0) {
    const first = content[0] as { html?: string; type?: string };
    // Already HTML-format.
    if (typeof first?.html === 'string') return first.html;
    // Legacy BlockNote block JSON — convert to HTML at runtime so old
    // documents keep rendering. It re-saves as HTML on the next edit.
    if (typeof first?.type === 'string') {
      const { blockNoteToHtml } = await import('./blocknote-to-html');
      return blockNoteToHtml(content as Record<string, unknown>[]);
    }
    return '';
  }
  // No doc row yet — try the legacy DOCX binary as a one-time import.
  const buf = await fetchDocumentDocx(fileId);
  if (!buf) return '';
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ arrayBuffer: buf }, { includeDefaultStyleMap: true });
  return result.value || '';
}

export async function putDocumentHtml(fileId: string, html: string): Promise<void> {
  await putDocumentJson(fileId, [{ html }]);
}
