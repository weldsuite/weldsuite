/**
 * WeldBooks settings are per legal entity. Inside WeldBooks the entity comes
 * from the sidebar switcher; in Settings there is no module sidebar, so this
 * shows the entity the settings act on, lets the member switch it, and renders
 * the children once the WeldBooks client points at that entity.
 */

import { useQueryClient } from '@tanstack/react-query';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { resetEntityScopedAccountingQueries } from '@/hooks/queries/use-accounting-queries';
import { useCurrentLegalEntity } from '@/hooks/use-current-legal-entity';
import { setWeldbooksEntityId } from '@/lib/api/weldbooks-client';
import { useI18n } from '@/lib/i18n/provider';
import { useSelectWeldbooksEntity } from '@/app/weldbooks/settings/entity-scope';

export function WeldbooksSettingsScope({ children }: Readonly<{ children: React.ReactNode }>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.settingsPage.entity;
  const queryClient = useQueryClient();
  const { entityId, entities, isLoading, setEntityId } = useCurrentLegalEntity({ app: 'weldbooks' });
  const ready = useSelectWeldbooksEntity(entityId ?? '');
  const active = entities.filter((e) => e.isActive !== false);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!entityId || active.length === 0) return <p className="text-sm text-muted-foreground">{ts.none}</p>;

  /** As the WeldBooks sidebar switcher does: point the client at the entity, then drop the previous entity's results. */
  const switchEntity = (id: string) => {
    if (id === entityId) return;
    setWeldbooksEntityId(id);
    setEntityId(id);
    void resetEntityScopedAccountingQueries(queryClient);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="weldbooks-settings-entity">{ts.label}</Label>
        <Select value={entityId} onValueChange={switchEntity}>
          <SelectTrigger id="weldbooks-settings-entity" className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {active.map((entity) => (
              <SelectItem key={entity.id} value={entity.id}>
                {entity.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{ts.hint}</p>
      </div>
      {ready ? children : <PageLoader fullScreen={false} />}
    </div>
  );
}
