
import { useState, useCallback } from 'react';
import { useAppApi } from '@/lib/api/use-app-api';

interface UploadedFile {
  id: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  mimeType: string;
  url: string;
  isPublic: boolean;
}

export interface UseFileUploadOptions {
  folder?: string;
  entityType?: string;
  entityId?: string;
  isPublic?: boolean;
  maxFileSize?: number; // in bytes
  allowedTypes?: string[];
  onProgress?: (progress: number, fileName: string) => void;
  onSuccess?: (file: UploadedFile) => void;
  onError?: (error: string, fileName: string) => void;
}

export interface UseFileUploadReturn {
  uploadFile: (file: File) => Promise<UploadedFile | null>;
  uploadMultiple: (files: File[]) => Promise<UploadedFile[]>;
  isUploading: boolean;
  progress: number;
  currentFileName: string | null;
  error: string | null;
  clearError: () => void;
}

export function useFileUpload(options: UseFileUploadOptions = {}): UseFileUploadReturn {
  const {
    folder,
    entityType,
    entityId,
    isPublic = false,
    maxFileSize,
    allowedTypes,
    onProgress,
    onSuccess,
    onError,
  } = options;

  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { storage } = useAppApi();

  const clearError = useCallback(() => setError(null), []);

  const uploadFile = useCallback(
    async (file: File): Promise<UploadedFile | null> => {
      setError(null);
      setIsUploading(true);
      setProgress(0);
      setCurrentFileName(file.name);

      try {
        // Validate file type if restrictions specified
        if (allowedTypes && !allowedTypes.includes(file.type)) {
          const errorMsg = `File type ${file.type} is not allowed`;
          setError(errorMsg);
          onError?.(errorMsg, file.name);
          return null;
        }

        // Validate file size if max specified
        if (maxFileSize && file.size > maxFileSize) {
          const errorMsg = `File size exceeds maximum of ${formatBytes(maxFileSize)}`;
          setError(errorMsg);
          onError?.(errorMsg, file.name);
          return null;
        }

        setProgress(10);
        onProgress?.(10, file.name);

        // Generate worker-proxied upload URL
        const urlResult = await storage.generateUploadUrl({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          folder,
          entityType,
          entityId,
          isPublic,
        });

        if (!urlResult.success || !urlResult.uploadUrl || !urlResult.uploadToken || !urlResult.fileKey) {
          const errorMsg = 'Failed to generate upload URL';
          setError(errorMsg);
          onError?.(errorMsg, file.name);
          return null;
        }

        setProgress(20);
        onProgress?.(20, file.name);

        // Upload file to presigned URL using XHR for progress tracking
        const etag = await uploadToPresignedUrl(
          urlResult.uploadUrl,
          file,
          (uploadProgress) => {
            // Map 20-90% of progress to the actual upload
            const mappedProgress = 20 + Math.round(uploadProgress * 0.7);
            setProgress(mappedProgress);
            onProgress?.(mappedProgress, file.name);
          }
        );

        setProgress(90);
        onProgress?.(90, file.name);

        // Confirm upload
        const confirmResult = await storage.confirmUpload({
          uploadToken: urlResult.uploadToken,
          fileKey: urlResult.fileKey,
          etag,
        });

        if (!confirmResult.success || !confirmResult.file) {
          const errorMsg = 'Failed to confirm upload';
          setError(errorMsg);
          onError?.(errorMsg, file.name);
          return null;
        }

        setProgress(100);
        onProgress?.(100, file.name);

        const uploadedFile: UploadedFile = confirmResult.file;
        onSuccess?.(uploadedFile);

        return uploadedFile;
      } catch (err: any) {
        const errorMsg = err?.message || 'Upload failed';
        setError(errorMsg);
        onError?.(errorMsg, file.name);
        return null;
      } finally {
        setIsUploading(false);
        setCurrentFileName(null);
      }
    },
    [folder, entityType, entityId, isPublic, maxFileSize, allowedTypes, onProgress, onSuccess, onError, storage]
  );

  const uploadMultiple = useCallback(
    async (files: File[]): Promise<UploadedFile[]> => {
      const results: UploadedFile[] = [];

      for (const file of files) {
        const result = await uploadFile(file);
        if (result) {
          results.push(result);
        }
      }

      return results;
    },
    [uploadFile]
  );

  return {
    uploadFile,
    uploadMultiple,
    isUploading,
    progress,
    currentFileName,
    error,
    clearError,
  };
}

// Helper: Upload file to presigned URL with progress tracking
async function uploadToPresignedUrl(
  url: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // Get ETag from response headers
        const etag = xhr.getResponseHeader('ETag');
        resolve(etag || undefined);
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload aborted'));
    });

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
  });
}

// Helper: Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
