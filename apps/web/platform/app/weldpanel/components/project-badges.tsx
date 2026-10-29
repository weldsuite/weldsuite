import { Badge } from '@weldsuite/ui/components/badge';
import type { PanelProjectKind, PanelProjectStatus } from '@weldsuite/app-api-client/schemas/weldpanel';
import { useI18n } from '@/lib/i18n/provider';

export function ProjectStatusBadge({ status }: Readonly<{ status: PanelProjectStatus }>) {
  const { t } = useI18n();
  return <Badge variant={status === 'active' ? 'success' : 'warning'}>{t.weldpanel.statuses[status]}</Badge>;
}

export function ProjectKindBadge({ kind }: Readonly<{ kind: PanelProjectKind }>) {
  const { t } = useI18n();
  return <Badge variant="outline">{t.weldpanel.kinds[kind]}</Badge>;
}
