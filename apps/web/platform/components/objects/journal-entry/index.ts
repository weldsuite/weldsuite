import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const JournalEntryPanel = lazy(() =>
  import('./journal-entry-panel').then((m) => ({ default: m.JournalEntryPanel })),
);

registerObjectPanel({
  type: 'journal_entry',
  label: 'Journal entry',
  component: JournalEntryPanel,
});

export { JournalEntryPanel };
