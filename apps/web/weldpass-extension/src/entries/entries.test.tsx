// @vitest-environment jsdom
/**
 * The page entry points: each mounts its page into `#root`, in the browser's
 * language. The pages themselves are stand-ins here; they have tests of their own.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../index.css', () => ({}));
vi.mock('../frames/Menu', () => ({ Menu: () => <p>menu page</p> }));
vi.mock('../frames/Prompt', () => ({ Prompt: () => <p>prompt page</p> }));
vi.mock('../popup/App', () => ({ App: () => <p>popup page</p> }));
vi.mock('../settings/SettingsPage', () => ({ SettingsPage: () => <p>settings page</p> }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  document.documentElement.lang = '';
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the page entries', () => {
  // Literal imports, so `vitest related` sees which entry each case loads.
  it.each([
    ['menu', () => import('./menu'), 'menu page'],
    ['prompt', () => import('./prompt'), 'prompt page'],
    ['popup', () => import('./popup'), 'popup page'],
    ['settings', () => import('./settings'), 'settings page'],
  ])('%s mounts its page', async (_name, load, text) => {
    await act(async () => {
      await load();
    });
    expect(document.getElementById('root')?.textContent).toBe(text);
    expect(document.documentElement.lang).toBe('en');
  });

  it('uses the browser language when there is one', async () => {
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'nl' } });
    const { mount } = await import('./mount');
    await act(async () => mount(<p>page</p>));
    expect(document.documentElement.lang).toBe('nl');
  });

  it('renders nothing without a #root', async () => {
    document.body.innerHTML = '';
    const { mount } = await import('./mount');
    expect(() => mount(<p>page</p>)).not.toThrow();
    expect(document.body.innerHTML).toBe('');
  });
});
