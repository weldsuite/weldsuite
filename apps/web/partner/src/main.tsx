import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import App from './App';
import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  console.warn('VITE_CLERK_PUBLISHABLE_KEY is not set');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={publishableKey || ''} signInUrl="/sign-in" afterSignOutUrl="/sign-in">
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <BrowserRouter>
            <App />
            <Toaster richColors position="top-right" />
          </BrowserRouter>
        </I18nProvider>
      </QueryClientProvider>
    </ClerkProvider>
  </StrictMode>,
);
