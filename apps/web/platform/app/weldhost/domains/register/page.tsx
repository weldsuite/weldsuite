import { Navigate } from '@tanstack/react-router';
import { isFeatureAvailable } from '@/lib/edition';
import { DomainRegistrationClient } from "./domain-registration-client";

export default function DomainRegistrationPage() {
  // Buying a domain is a Stripe checkout, which some editions lack.
  if (!isFeatureAvailable('domain-purchase')) return <Navigate to="/weldhost/domains" />;
  return <DomainRegistrationClient />;
}
