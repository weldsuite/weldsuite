/**
 * The renderer's settings, from the environment (server only):
 *
 * - `STOREFRONT_API_URL`: the WeldSuite server (`weldsuite serve`), e.g. `http://localhost:8789`;
 * - `STOREFRONT_RENDERER_SECRET`: shared with the server and its storefront edge;
 * - `STOREFRONT_EDITOR_ORIGINS`: comma-separated origins of the platform, allowed to drive previews;
 * - `FORMS_PORTAL_URL`: WeldForms' portal, for contact form sections (optional).
 */

import { withoutTrailingSlashes } from '../seo';

/** An environment variable, trimmed; undefined when unset or blank. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export interface RendererConfig {
  apiUrl: string;
  secret: string;
  editorOrigins: string[];
  formsPortalUrl: string | null;
}

export class RendererNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} is not set: the storefront renderer cannot reach the WeldSuite server.`);
    this.name = 'RendererNotConfiguredError';
  }
}

/** The renderer's secret alone (the edge check needs nothing else). */
export function rendererSecret(): string | undefined {
  return env('STOREFRONT_RENDERER_SECRET');
}

export function rendererConfig(): RendererConfig {
  const apiUrl = env('STOREFRONT_API_URL');
  if (!apiUrl) throw new RendererNotConfiguredError('STOREFRONT_API_URL');
  const secret = rendererSecret();
  if (!secret) throw new RendererNotConfiguredError('STOREFRONT_RENDERER_SECRET');
  const editorOrigins = (env('STOREFRONT_EDITOR_ORIGINS') ?? '')
    .split(',')
    .map((entry) => origin(entry.trim()))
    .filter((entry): entry is string => entry !== null);
  const forms = env('FORMS_PORTAL_URL');
  return {
    apiUrl: withoutTrailingSlashes(apiUrl),
    secret,
    editorOrigins,
    formsPortalUrl: forms ? origin(forms) : null,
  };
}
