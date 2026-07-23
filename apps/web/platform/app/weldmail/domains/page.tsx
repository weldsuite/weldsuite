import { Navigate } from '@tanstack/react-router';

// Mail-domain management moved into WeldHost. Send users there.
export default function DomainsPage() {
  return <Navigate to="/weldhost/domains" />;
}
