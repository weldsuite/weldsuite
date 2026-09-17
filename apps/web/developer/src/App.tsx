import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, ProtectedRoute, SignInPage, SignUpPage } from '@/components/auth';
import { AppsPage } from '@/pages/AppsPage';
import { CreateAppPage } from '@/pages/CreateAppPage';
import { AppDetailPage } from '@/pages/AppDetailPage';
import { GettingStartedPage } from '@/pages/GettingStartedPage';

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in/*" element={<SignInPage />} />
      <Route path="/sign-up/*" element={<SignUpPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/apps" replace />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/new" element={<CreateAppPage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/getting-started" element={<GettingStartedPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/apps" replace />} />
    </Routes>
  );
}
