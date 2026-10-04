import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './popup/App';
import './index.css';

const root = document.getElementById('root');
if (root) {
  document.documentElement.lang =
    typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getUILanguage() : 'en';
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
