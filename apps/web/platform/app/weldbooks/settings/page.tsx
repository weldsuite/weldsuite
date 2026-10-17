/**
 * `/weldbooks/settings`: the WeldBooks settings moved to the WeldBooks tab of
 * the entity in Settings → Entities. Kept for the sidebar link, the back links
 * of the settings pages and old bookmarks: opens that tab for the entity
 * selected in WeldBooks.
 */

import { useEffect } from 'react';
import { Navigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { useCurrentAccountingEntityRow } from '@/hooks/use-current-entity-currency';

export default function WeldbooksSettingsRedirect() {
  const { entity } = useCurrentAccountingEntityRow();

  // The settings back button returns to WeldBooks, not to this redirect.
  useEffect(() => {
    sessionStorage.setItem('settings-return-url', '/weldbooks');
  }, []);

  if (!entity) return <PageLoader fullScreen={false} />;

  return <Navigate to="/settings/entities/$id/edit" params={{ id: entity.id }} search={{ tab: 'weldbooks' }} replace />;
}
