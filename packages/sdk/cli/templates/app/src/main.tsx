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
    <WeldAppProvider>
      <WeldAppGate fallback={<p className="status">Connecting to WeldSuite…</p>}>
        <App />
      </WeldAppGate>
    </WeldAppProvider>
  </StrictMode>,
);
