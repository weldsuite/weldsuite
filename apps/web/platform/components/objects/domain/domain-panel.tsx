/**
 * Domain object panel — tier-1: delegates to the existing
 * `DomainDetailPanel` from `@/components/weldhost`. That panel brings its
 * own chrome (header / tabs / close / expand), so we don't wrap it in
 * `EntityDetailView` like the simple panels do; instead the ObjectPanel
 * `mode` is mapped onto the panel's `isExpanded` / `onToggleExpand` props
 * so the stack-driven mode toggle still works.
 *
 * Once `DomainDetailPanel` is migrated to the unified `EntityDetailView`
 * shell, swap this for `<SimpleObjectPanel ... />` or full inline editing.
 */

import { useQuery } from '@tanstack/react-query';
import type { HostDomain } from '@/lib/api/domains/weldhost';
import { useAppApi } from '@/lib/api/use-app-api';
import { DomainDetailPanel } from '@/components/weldhost/domain-detail-panel';
import type { ObjectPanelComponentProps } from '@/components/object-panel';

interface ApiResponse<T> {
  success?: boolean;
  data?: T;
}

function useDomain(id: string) {
  const { domains } = useAppApi();
  return useQuery({
    queryKey: ['weldhost', 'domain', id],
    queryFn: () => domains.get(id) as unknown as Promise<ApiResponse<HostDomain>>,
    enabled: !!id,
  });
}

export function DomainPanel({
  id,
  isOpen,
  onClose,
  mode,
  onModeChange,
}: ObjectPanelComponentProps) {
  const { data } = useDomain(id);
  const domain = data?.data ?? null;
  const isExpanded = mode === 'fullscreen';
  return (
    <DomainDetailPanel
      domain={domain}
      isOpen={isOpen}
      onClose={onClose}
      isExpanded={isExpanded}
      onToggleExpand={() => onModeChange?.(isExpanded ? 'panel' : 'fullscreen')}
    />
  );
}
