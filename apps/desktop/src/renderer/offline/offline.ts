import '../shared/page.css';
import './offline.css';
import { applyText, text } from '../shared/strings';

/**
 * Shown in the app view when the server doesn't answer (src/main/index.ts,
 * `did-fail-load`). It runs with the app view's preload, so it reaches the
 * shell through the same bridge the platform uses.
 */
interface OfflineBridge {
  reloadApp(): Promise<boolean>;
  openServerSettings?(): Promise<boolean>;
}

const desktop = (window as Window & { weldsuiteDesktop?: OfflineBridge }).weldsuiteDesktop;
const params = new URLSearchParams(location.search);
const host = params.get('host') ?? '';
const error = params.get('error') ?? '';

applyText();
document.title = text('offlineTitle');
document.querySelector('#heading')!.textContent = text('offlineHeading', { host });
document.querySelector('#detail')!.textContent = error ? text('offlineDetail', { error }) : '';

const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const changeServer = document.querySelector<HTMLButtonElement>('#change-server')!;

let retrying = false;
function tryAgain(): void {
  if (retrying || !desktop) return;
  retrying = true;
  retry.disabled = true;
  void desktop.reloadApp().finally(() => {
    retrying = false;
    retry.disabled = false;
  });
}

retry.addEventListener('click', tryAgain);
// Back online: try at once instead of waiting for a click.
window.addEventListener('online', tryAgain);

if (typeof desktop?.openServerSettings === 'function') {
  changeServer.hidden = false;
  changeServer.addEventListener('click', () => void desktop.openServerSettings?.());
}

retry.focus();
