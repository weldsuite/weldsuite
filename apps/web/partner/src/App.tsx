import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { SignInPage } from '@/components/auth';
import PartnerLayout from '@/app/layout';
import OverviewPage from '@/app/page';
import WorkspacesPage from '@/app/workspaces/page';
import WorkspaceDetailPage from '@/app/workspaces/detail-page';
import RequestsPage from '@/app/requests-page';
import PackagesPage from '@/app/packages-page';
import StatementsPage from '@/app/statements/page';
import StatementDetailPage from '@/app/statements/detail-page';
import TeamPage from '@/app/team-page';
import SettingsPage from '@/app/settings-page';

function Portal() {
  return (
    <PartnerLayout>
      <Outlet />
    </PartnerLayout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in/*" element={<SignInPage />} />

      <Route element={<Portal />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/workspaces/:workspaceId" element={<WorkspaceDetailPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/packages" element={<PackagesPage />} />
        <Route path="/statements" element={<StatementsPage />} />
        <Route path="/statements/:statementId" element={<StatementDetailPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
