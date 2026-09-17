import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WeldAppGate, WeldAppProvider } from '@weldsuite/app-sdk/react';
import App from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    {/*
      localDev + Vite DEV: opening http://localhost:5173/ works without the
      platform iframe (mock host + in-memory storage + banner). When
      `weld app dev` embeds this server in WeldSuite, the real host still wins.
      Also: ?weldLocal=1 or window.__WELD_LOCAL_DEV__ = true
    */}
    <WeldAppProvider localDev={import.meta.env.DEV}>
      <WeldAppGate fallback={<p className="status">Connecting to WeldSuite…</p>}>
        <App />
      </WeldAppGate>
    </WeldAppProvider>
  </StrictMode>,
);
