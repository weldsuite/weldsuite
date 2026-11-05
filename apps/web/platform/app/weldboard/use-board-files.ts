/**
 * Images on boards: uploading to WeldDrive storage (in a workspace) or
 * keeping them inside the board (the signed-out preview), and loading them
 * for drawing, private WeldDrive files with the member's session.
 */

import { useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useFileUpload } from '@/hooks/use-file-upload';
import { getAppApiUrl } from '@/lib/api/public-env';
import type { UploadedImage } from './editor/board-editor';

const WEB_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** The preview keeps images inside the board: keep them small. */
const MAX_INLINE_BYTES = 1_500_000;
const PRIVATE_PATH = '/api/storage/private/';

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function imageSize(src: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
  return { width: img.naturalWidth || 320, height: img.naturalHeight || 240 };
}

export function useUploadImage(): (file: File) => Promise<UploadedImage | null> {
  const preview = usePreviewMode();
  const { uploadFile } = useFileUpload({ folder: 'weldboard', maxFileSize: MAX_IMAGE_BYTES, allowedTypes: WEB_IMAGES });
  return useCallback(
    async (file: File) => {
      if (!WEB_IMAGES.includes(file.type)) return null;
      const local = URL.createObjectURL(file);
      const size = await imageSize(local);
      URL.revokeObjectURL(local);
      if (preview) {
        if (file.size > MAX_INLINE_BYTES) return null;
        return { src: await readDataUrl(file), ...size, name: file.name };
      }
      if (file.size > MAX_IMAGE_BYTES) return null;
      const uploaded = await uploadFile(file);
      return uploaded?.url ? { src: uploaded.url, ...size, name: file.name } : null;
    },
    [preview, uploadFile],
  );
}

/** A private WeldDrive address on app-api itself. */
function isPrivate(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return url.origin === new URL(getAppApiUrl()).origin && url.pathname.startsWith(PRIVATE_PATH);
  } catch {
    return false;
  }
}

/** Turns an image source into something an <img> or canvas can load. Cached per source. */
export function useImageLoader(): (src: string) => Promise<string | null> {
  const { getToken } = useAuth();
  const cache = useRef(new Map<string, Promise<string | null>>());
  return useCallback(
    (src: string) => {
      let hit = cache.current.get(src);
      if (hit) return hit;
      hit = (async () => {
        if (src.startsWith('data:')) return src;
        if (!isPrivate(src)) return src;
        const token = await getToken();
        const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      })().catch(() => null);
      cache.current.set(src, hit);
      return hit;
    },
    [getToken],
  );
}
