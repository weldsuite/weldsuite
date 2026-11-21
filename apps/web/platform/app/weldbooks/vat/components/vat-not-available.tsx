import { FileX } from 'lucide-react';
import { JurisdictionUnavailable } from '@/components/accounting/jurisdiction-gate';

/** Shown when the entity's jurisdiction has no VAT return in WeldBooks (yet). */
export function VatNotAvailable({ title, description }: Readonly<{ title: string; description: string }>) {
  return <JurisdictionUnavailable feature={title} title={title} description={description} icon={FileX} />;
}
