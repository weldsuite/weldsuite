import { Lock } from 'lucide-react';
import type { LegalEntityApp } from '@weldsuite/app-api-client/schemas/legal-entities';
import { useI18n } from '@/lib/i18n/provider';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';
import { SidebarScopeSwitcher } from '@/components/layout/sidebar-scope-switcher';

interface LegalEntitySwitcherProps {
  /** Only the entities this app is enabled for. */
  app: LegalEntityApp;
  currentId: string | null | undefined;
  onSelect: (id: string) => void;
  /** Called by the "Add legal entity" row; the row is hidden without it. */
  onAdd?: () => void;
  /** Row text for `onAdd`; defaults to "Add legal entity…". */
  addLabel?: string;
}

/**
 * Sidebar switcher (top of the WeldBooks and WeldHR sidebars) for the workspace's
 * legal entities. Lists the entities `app` is enabled for that the member can see,
 * marks restricted ones with a lock and shows the role the member acts with in the
 * selected entity. The caller owns what a selection does (WeldBooks and WeldHR each
 * point their API client at the entity and reset their queries).
 */
export function LegalEntitySwitcher({ app, currentId, onSelect, onAdd, addLabel }: Readonly<LegalEntitySwitcherProps>) {
  const { t } = useI18n();
  const tl = t.accounting.legalEntities;
  const { data: entities = [] } = useLegalEntities({ app });

  return (
    <SidebarScopeSwitcher
      options={entities
        .filter((e) => e.isActive)
        .map((e) => ({
          id: e.id,
          name: e.name,
          description: [
            e.jurisdictionCode,
            e.baseCurrency,
            e.myAccess?.roleName ? tl.yourRole.replace('{role}', e.myAccess.roleName) : e.legalName,
          ]
            .filter(Boolean)
            .join(' · '),
          trailing:
            e.accessRestricted || e.isDefault ? (
              <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                {e.accessRestricted ? <Lock className="h-3 w-3" aria-label={tl.restricted} /> : null}
                {e.isDefault ? tl.default : null}
              </span>
            ) : undefined,
        }))}
      currentId={currentId}
      onSelect={onSelect}
      label={tl.label}
      placeholder={tl.placeholder}
      addLabel={onAdd ? (addLabel ?? tl.addEntity) : undefined}
      onAdd={onAdd}
    />
  );
}
