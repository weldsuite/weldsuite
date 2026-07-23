import { useEffect, useState } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { SpreadsheetView } from '../spreadsheet-view';
import { tablesApi } from '@/app/weldflow/lib/api-client';

// Dedicated route for editing one workbook. URL is the source of truth, so
// refresh keeps the user on the same sheet (instead of bouncing back to the
// project's table list and losing auto-save context).
export default function ProjectTableEditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const fileId = params.fileId as string;

  const [name, setName] = useState<string>('');

  // Fetch the file row to populate the editor header. We use the list
  // endpoint since there's no per-file GET on `tablesApi`; the list is
  // small enough that this is fine, and TanStack Query in `useSpreadsheet`
  // handles the heavy lifting of the xlsx content itself.
  useEffect(() => {
    let cancelled = false;
    tablesApi.listTables(projectId).then((res) => {
      if (cancelled || !res.success || !res.data) return;
      const match = res.data.find((it: { id: string; name: string }) => it.id === fileId);
      if (match) setName(match.name);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, fileId]);

  return (
    <SpreadsheetView
      key={fileId}
      projectId={projectId}
      tableId={fileId}
      tableName={name}
      onBack={() => router.push(`/weldflow/project/${projectId}/table`)}
    />
  );
}
