import { createFileRoute } from '@tanstack/react-router';
import { DrivePage } from '@/app/welddrive/components/drive-page';

export const Route = createFileRoute('/welddrive/uploads/')({
  component: () => <DrivePage view="uploads" />,
});
