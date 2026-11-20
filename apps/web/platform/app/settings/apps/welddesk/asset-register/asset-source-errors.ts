import { isApiError } from '@weldsuite/api-client';
import { ASSET_SOURCE_ERROR_CODES, type AssetSourceErrorCode } from '@weldsuite/core-api-client/schemas/asset-sources';
import type { TranslationsType } from '@/lib/i18n/types';

type Errors = TranslationsType['assetSources']['intune']['errors'];

function isKnownCode(code: string | null | undefined): code is AssetSourceErrorCode {
  return (ASSET_SOURCE_ERROR_CODES as readonly string[]).includes(code ?? '');
}

/** The wording of a stable error code, in the member's language; the API's own message is the fallback. */
export function assetSourceErrorText(errors: Errors, code: string | null | undefined, message?: string | null): string {
  if (isKnownCode(code)) return errors[code];
  return message || errors.unknown;
}

/** `{ status, code }` of a failed API call, when it carries an error body. */
export function apiErrorInfo(err: unknown): { status: number | null; code: string | null } {
  if (!isApiError(err)) return { status: null, code: null };
  const body = err.body as { error?: { code?: unknown } } | undefined;
  const code = body?.error?.code;
  return { status: err.status, code: typeof code === 'string' ? code : null };
}
