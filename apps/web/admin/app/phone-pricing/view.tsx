import { PhonePricingList } from './phone-pricing-list';
import type { PhonePricingPageData } from './data';

export function PhonePricingPage({ rows, stats, defaultMarkup }: Readonly<PhonePricingPageData>) {
  return <PhonePricingList rows={rows} stats={stats} defaultMarkup={defaultMarkup} />;
}
