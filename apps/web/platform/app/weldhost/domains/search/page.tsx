import { Navigate } from '@tanstack/react-router';
import { isFeatureAvailable } from '@/lib/edition';
import { DomainSearchClient } from "./domain-search-client";

export default function DomainSearchPage() {
  // Buying a domain is a Stripe checkout, which some editions lack.
  if (!isFeatureAvailable('domain-purchase')) return <Navigate to="/weldhost/domains" />;
  return <DomainSearchClient />;
}
