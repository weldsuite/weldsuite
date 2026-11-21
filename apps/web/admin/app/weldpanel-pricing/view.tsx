import { WeldpanelPricingForm } from './weldpanel-pricing-form';
import type { WeldpanelPricingPageData } from './data';

export function WeldpanelPricingPage({ pricing }: Readonly<WeldpanelPricingPageData>) {
  return <WeldpanelPricingForm pricing={pricing} />;
}
