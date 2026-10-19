import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { DrivePage } from '@/app/welddrive/components/drive-page';

interface DriveSearch {
  folderId?: string;
  /** A shared link to one file ("Copy link" / Share): it opens in the preview. */
  file?: string;
}

export const Route = createFileRoute('/welddrive/')({
  validateSearch: (search: Record<string, unknown>): DriveSearch => ({
    folderId: (search.folderId as string) || undefined,
    file: (search.file as string) || undefined,
  }),
  component: DrivePageWrapper,
});

function DrivePageWrapper() {
  const { folderId, file } = useSearch({ from: '/welddrive/' });
  const navigate = useNavigate();
  return (
    <DrivePage
      view="my-drive"
      folderId={folderId}
      fileId={file}
      onFileLinkClosed={() => navigate({ to: '/welddrive', search: { folderId }, replace: true })}
    />
  );
}
