import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/weldbooks/')({
  component: () => <Navigate to="/weldbooks/dashboard" />,
});
