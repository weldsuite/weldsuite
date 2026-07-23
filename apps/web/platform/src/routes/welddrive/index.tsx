import { createFileRoute, useSearch } from '@tanstack/react-router';
import { DrivePage } from '@/app/welddrive/components/drive-page';

export const Route = createFileRoute('/welddrive/')({
  validateSearch: (search: Record<string, unknown>) => ({
    folderId: (search.folderId as string) || undefined,
  }),
  component: DrivePageWrapper,
});

function DrivePageWrapper() {
  const { folderId } = useSearch({ from: '/welddrive/' });
  return <DrivePage view="my-drive" folderId={folderId} />;
}
