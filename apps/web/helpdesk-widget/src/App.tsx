import { BrowserRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { WidgetPage } from './pages/WidgetPage';
import { LauncherPage } from './pages/LauncherPage';

/** The SDK loads `/?mode=launcher` and `/?mode=widget` into its two iframes. */
function RootPage() {
  const [searchParams] = useSearchParams();
  return searchParams.get('mode') === 'launcher' ? <LauncherPage /> : <WidgetPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/widget" element={<WidgetPage />} />
        <Route path="/launcher" element={<LauncherPage />} />
        <Route path="*" element={<RootPage />} />
      </Routes>
      <Analytics />
    </BrowserRouter>
  );
}
