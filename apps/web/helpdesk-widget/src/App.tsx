import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { WidgetPage } from './pages/WidgetPage';
import { LauncherPage } from './pages/LauncherPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/widget" element={<WidgetPage />} />
        <Route path="/launcher" element={<LauncherPage />} />
        <Route path="/" element={<WidgetPage />} />
      </Routes>
      <Analytics />
    </BrowserRouter>
  );
}
