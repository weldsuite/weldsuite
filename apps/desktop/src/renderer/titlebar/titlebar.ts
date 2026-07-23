import './titlebar.css';

interface TitlebarApi {
  readonly platform: NodeJS.Platform;
  navBack(): Promise<boolean>;
  navForward(): Promise<boolean>;
  navReload(): Promise<boolean>;
  getNavState(): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
  onNavState(listener: (s: { canGoBack: boolean; canGoForward: boolean }) => void): () => void;
  onTitle(listener: (title: string) => void): () => void;
}

declare global {
  interface Window { weldsuiteTitlebar: TitlebarApi }
}

const api = window.weldsuiteTitlebar;

const root = document.querySelector<HTMLDivElement>('.titlebar')!;
const back = document.querySelector<HTMLButtonElement>('#back')!;
const forward = document.querySelector<HTMLButtonElement>('#forward')!;
const reload = document.querySelector<HTMLButtonElement>('#reload')!;
const title = document.querySelector<HTMLSpanElement>('#title-text')!;

root.dataset.platform = api.platform;

back.addEventListener('click', () => api.navBack());
forward.addEventListener('click', () => api.navForward());
reload.addEventListener('click', () => api.navReload());

const applyState = (s: { canGoBack: boolean; canGoForward: boolean }) => {
  back.disabled = !s.canGoBack;
  forward.disabled = !s.canGoForward;
};

api.onNavState(applyState);
api.getNavState().then(applyState).catch(() => undefined);

api.onTitle((t) => { if (t) title.textContent = t; });
