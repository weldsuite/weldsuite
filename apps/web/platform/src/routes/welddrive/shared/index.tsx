import { createFileRoute } from '@tanstack/react-router';
import { DrivePage } from '@/app/welddrive/components/drive-page';

export const Route = createFileRoute('/welddrive/shared/')({
  component: () => <DrivePage view="shared" />,
});
