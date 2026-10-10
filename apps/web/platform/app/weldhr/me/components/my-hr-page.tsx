/** Frame for a My HR page: the "WeldHR › My HR › <page>" breadcrumb and the padded, scrolling content. */

import type { ReactNode } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { MY_HR_PATHS } from '../../access';
import { DetailPage, useHrBreadcrumbs } from '../../components/page-kit';

/** Breadcrumb for a My HR page; without a `page` label it is the My HR overview itself. */
export function useMyHrBreadcrumbs(page?: string) {
  const t = useTranslations();
  useHrBreadcrumbs(
    page ? { label: t('weldhr.me.title'), href: MY_HR_PATHS.overview } : { label: t('weldhr.me.title') },
    page ? { label: page } : null,
  );
}

/** A My HR page other than the overview: sets its breadcrumb and stacks its sections. */
export function MyHrPage({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  useMyHrBreadcrumbs(title);
  return (
    <DetailPage>
      <div className="space-y-4">{children}</div>
    </DetailPage>
  );
}
