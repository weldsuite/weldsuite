import { WeldmeetAiPricingForm } from './weldmeet-ai-pricing-form';
import type { WeldmeetAiPricingPageData } from './data';

export function WeldmeetAiPricingPage({ pricing }: Readonly<WeldmeetAiPricingPageData>) {
  return <WeldmeetAiPricingForm pricing={pricing} />;
}
