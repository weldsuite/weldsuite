/**
 * The WeldBooks settings moved under the entity in Settings → Entities: its
 * WeldBooks tab, and the invoice templates with their designer. The old
 * `/weldbooks/settings` URLs stay for the WeldBooks sidebar, back links and
 * bookmarks, and open the new place for the entity selected in WeldBooks.
 */

import { useEffect } from 'react';
import { Navigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { useCurrentAccountingEntityRow } from '@/hooks/use-current-entity-currency';
import { useParams } from '@/lib/router';

/** The selected entity's id once known; the settings back button then returns to WeldBooks, not to the redirect. */
function useRedirectEntityId(): string | undefined {
  const { entity } = useCurrentAccountingEntityRow();

  useEffect(() => {
    sessionStorage.setItem('settings-return-url', '/weldbooks');
  }, []);

  return entity?.id;
}

/** `/weldbooks/settings` → the WeldBooks tab of the entity. */
export function WeldbooksSettingsRedirect() {
  const entityId = useRedirectEntityId();
  if (!entityId) return <PageLoader fullScreen={false} />;
  return <Navigate to="/settings/entities/$id/edit" params={{ id: entityId }} search={{ tab: 'weldbooks' }} replace />;
}

/** `/weldbooks/settings/invoice-templates` → the entity's invoice templates. */
export function InvoiceTemplatesRedirect() {
  const entityId = useRedirectEntityId();
  if (!entityId) return <PageLoader fullScreen={false} />;
  return <Navigate to="/settings/entities/$id/invoice-templates" params={{ id: entityId }} replace />;
}

/**
 * `/weldbooks/settings/invoice-templates/:id` → the designer of that template.
 * The designer moves on to the template's own entity when it is another one.
 */
export function InvoiceTemplateRedirect() {
  const entityId = useRedirectEntityId();
  const { id: templateId } = useParams<{ id: string }>();
  if (!entityId) return <PageLoader fullScreen={false} />;
  return (
    <Navigate
      to="/settings/entities/$id/invoice-templates/$templateId"
      params={{ id: entityId, templateId }}
      replace
    />
  );
}
