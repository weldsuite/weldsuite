/**
 * Storage presets of raw exports: what each provider needs filled in, and
 * sensible defaults. All of them speak the S3 API; only AWS S3 works without
 * an endpoint.
 */

import type { PanelExportProvider } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

export interface ExportProviderPreset {
  /** The endpoint field is shown (and required). */
  needsEndpoint: boolean;
  endpointPlaceholder: string;
  defaultRegion: string;
  regionPlaceholder: string;
  pathStyle: boolean;
}

export const EXPORT_PROVIDER_PRESETS: Record<PanelExportProvider, ExportProviderPreset> = {
  s3: { needsEndpoint: false, endpointPlaceholder: '', defaultRegion: 'eu-central-1', regionPlaceholder: 'eu-central-1', pathStyle: false },
  r2: { needsEndpoint: true, endpointPlaceholder: 'https://<account-id>.r2.cloudflarestorage.com', defaultRegion: 'auto', regionPlaceholder: 'auto', pathStyle: false },
  gcs: { needsEndpoint: true, endpointPlaceholder: 'https://storage.googleapis.com', defaultRegion: 'auto', regionPlaceholder: 'auto', pathStyle: false },
  minio: { needsEndpoint: true, endpointPlaceholder: 'https://minio.example.com', defaultRegion: 'us-east-1', regionPlaceholder: 'us-east-1', pathStyle: true },
  other: { needsEndpoint: true, endpointPlaceholder: 'https://s3.example.com', defaultRegion: 'us-east-1', regionPlaceholder: 'us-east-1', pathStyle: false },
};

/** `https://` origin, no path, query or credentials: what the API accepts as an endpoint. */
export function isExportEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.username === '' && url.password === '' && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** `12 345 678` bytes → `11.8 MB`. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}
