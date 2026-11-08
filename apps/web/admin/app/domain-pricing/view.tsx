import { DomainPricingList } from './domain-pricing-list';
import type { DomainPricingPageData } from './data';

export function DomainPricingPage({ rows, stats }: Readonly<DomainPricingPageData>) {
  return <DomainPricingList rows={rows} stats={stats} />;
}
