import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';

/** Render an extension page into `#root`, in the browser's language. */
export function mount(page: ReactNode): void {
  const root = document.getElementById('root');
  if (!root) return;
  document.documentElement.lang =
    typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getUILanguage() : 'en';
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}
