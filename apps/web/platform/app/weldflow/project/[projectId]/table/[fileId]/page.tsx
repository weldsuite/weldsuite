import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useParams, useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { LiveSheet } from '@/app/weldsheets/sheet/live-sheet';
import { MissingSheet } from '@/app/weldsheets/sheet/sheet-chrome';
import { sheetsQueryKey } from '@/app/weldsheets/store/use-sheet-store';

/**
 * One sheet of a WeldFlow project, in the WeldSheets editor inside the
 * project. The URL names the drive file, so links from WeldDrive and from
 * before WeldSheets keep working: a sheet saved by the old project grid (an
 * .xlsx file) becomes a WeldSheets spreadsheet the first time anyone opens it.
 */
export default function ProjectTableEditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const fileId = params.fileId as string;
  const sheets = useAppApi().sheets;
  const { t } = useI18n();
  const firstTabName = t.weldsheets.home.firstTab;

  // Converting twice is harmless (the second answers with the first's sheet), so this can be a query.
  const opened = useQuery({
    queryKey: [...sheetsQueryKey, 'project-file', fileId],
    queryFn: async () => (await sheets.convertProjectSheet({ fileId, firstTabName })).data,
    staleTime: Infinity,
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 2,
  });

  if (opened.isPending) return <PageLoader fullScreen={false} />;
  if (!opened.data) return <MissingSheet message={t.weldsheets.home.notFound} />;
  return <LiveSheet key={opened.data.id} sheetId={opened.data.id} embedded onBack={() => router.push(`/weldflow/project/${projectId}/table`)} />;
}
