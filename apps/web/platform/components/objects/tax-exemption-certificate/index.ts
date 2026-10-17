import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const TaxExemptionCertificatePanel = lazy(() =>
  import('./tax-exemption-certificate-panel').then((m) => ({ default: m.TaxExemptionCertificatePanel })),
);

registerObjectPanel({
  type: 'tax_exemption_certificate',
  label: 'Exemption certificate',
  component: TaxExemptionCertificatePanel,
});

export { TaxExemptionCertificatePanel };
