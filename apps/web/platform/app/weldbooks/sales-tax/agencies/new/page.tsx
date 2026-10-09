import { useSearch } from '@tanstack/react-router';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../../setup/setup-gate';
import { useSetupTexts } from '../../setup/setup-texts';
import { AgencyWizard } from '../agency-wizard';

function NewAgency() {
  const { t } = useSetupTexts();
  const { canCreate } = useSalesTaxSetupAccess();
  // The nexus monitor links here with `?state=TX`.
  const search = useSearch({ strict: false }) as { state?: string };
  if (!canCreate) return <p className="p-6 text-sm text-muted-foreground">{t.common.noAccess}</p>;
  return <AgencyWizard initialStateCode={search.state} />;
}

/** Register in a state: the wizard, behind the US and permission gate. */
export default function NewSalesTaxAgencyPage() {
  return (
    <SalesTaxSetupGate>
      <NewAgency />
    </SalesTaxSetupGate>
  );
}
