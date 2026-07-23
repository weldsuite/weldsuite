import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host wraps the renderer in <Suspense>).
const WelddataLeadPanel = lazy(() =>
  import('./welddata-lead-panel').then((m) => ({ default: m.WelddataLeadPanel })),
);

registerObjectPanel({
  type: 'welddata-lead',
  label: 'Lead',
  component: WelddataLeadPanel,
});

;
export {
  welddataLeadCacheAtom,
  welddataLeadFromSearchRow,
  welddataLeadFromSavedLead,
  
} from './welddata-lead-data';
