import { WorkspaceDetail } from './workspace-detail';
import type { WorkspaceDetailPageData } from './data';

export function WorkspaceDetailPage({
  workspace,
  members,
  billing,
  plans,
  credits,
  invoices,
  payments,
  activity,
  snapshotState,
  ssoState,
  appAccess,
  appUsage,
  outbound,
  database,
  databaseTab,
  canWrite,
  canMoveDatabase,
}: Readonly<WorkspaceDetailPageData>) {
  return (
    <WorkspaceDetail
      workspace={workspace}
      members={members}
      billing={billing}
      plans={plans}
      credits={credits}
      invoices={invoices}
      payments={payments}
      activity={activity}
      snapshotState={snapshotState}
      ssoState={ssoState}
      appAccess={appAccess}
      appUsage={appUsage}
      outbound={outbound}
      database={database}
      databaseTab={databaseTab}
      canWrite={canWrite}
      canMoveDatabase={canMoveDatabase}
    />
  );
}
