/**
 * Overview section — legacy. The companion `CustomerDetailsSidebar` lived
 * under `app/weldcrm/customers/[id]/` which was deleted in the
 * companies/people refactor. This file is a stub so the surrounding
 * `customer-detail/` infrastructure still type-checks while it's migrated
 * to the new `/api/companies` + `/api/people` surfaces.
 */

import type { OverviewSectionProps } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function OverviewSection(_props: OverviewSectionProps) {
  const t = useTranslations();
  return (
    <div className="p-4 text-sm text-muted-foreground">
      {t('sweep.weldcrm.overviewSection.migrationNotice')}
    </div>
  );
}
