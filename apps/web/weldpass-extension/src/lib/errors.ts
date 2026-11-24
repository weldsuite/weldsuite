import type { MessageKey } from './i18n';
import { RemoteError } from './messaging';

/** The message to show for a failed call to the worker. Never echoes the error's own text. */
export function errorMessageKey(error: unknown): MessageKey {
  if (!(error instanceof RemoteError)) return 'errorGeneric';
  switch (error.code) {
    case 'network':
      return 'errorNetwork';
    case 'signed-out':
      return 'errorSession';
    case 'no-workspace':
      return 'pickWorkspaceTitle';
    case 'no-server':
    case 'worker':
      return 'errorServer';
    case 'api':
      if (error.status === 401) return 'errorSession';
      if (error.status === 403) return 'errorForbidden';
      if (error.status === 404) return 'errorNotFound';
      return 'errorGeneric';
    default:
      return 'errorGeneric';
  }
}
