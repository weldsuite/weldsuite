/**
 * Per-member permission overrides, per app.
 *
 * Every cell shows what the member effectively gets for that app. By default a
 * cell inherits from the member's role (muted). A click overrides it for this
 * member only: a permission the role doesn't give becomes "allowed", one the
 * role does give becomes "denied". Clicking an override again returns it to
 * the role's value. Denies always win, so a member can be kept out of, say,
 * companies in WeldDesk while keeping them in WeldCRM.
 */

import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Check, Loader2, Minus, X } from 'lucide-react';
import { checkAppPermission, hasPermission, toAppScopedKeys } from '@weldsuite/permissions';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';
import {
  PermissionMatrixTable,
  PermissionSectionNav,
  SectionIcon,
  WORKSPACE_SECTION_ID,
  extraActionLabel,
  filterSections,
  usePermissionSections,
  type MatrixPermission,
  type PermissionSection,
} from '@/components/settings/app-permission-matrix';

type CellState = 'inherit' | 'allow' | 'deny';

export interface MemberAppPermissionsProps {
  /** What the member inherits from their role (custom role or system tier). */
  inheritedPermissions: string[];
  /** Grants stored on the member row. */
  memberOverrides: string[];
  /** Denies stored on the member row. */
  memberDenies: string[];
  /** Installed app codes; apps not installed are hidden. */
  installedAppCodes?: string[];
  roleLabel: string;
  canManage: boolean;
  /** Persist both lists. Resolve true on success. */
  onSave: (permissions: string[], permissionDenies: string[]) => Promise<boolean>;
}

export function MemberAppPermissions({
  inheritedPermissions,
  memberOverrides,
  memberDenies,
  installedAppCodes,
  roleLabel,
  canManage,
  onSave,
}: MemberAppPermissionsProps) {
  const t = useTranslations();

  // Stored lists may predate the per-app format; show them per app.
  const savedGrants = React.useMemo(() => new Set(toAppScopedKeys(memberOverrides)), [memberOverrides]);
  const savedDenies = React.useMemo(() => new Set(toAppScopedKeys(memberDenies)), [memberDenies]);
  const [grants, setGrants] = React.useState<Set<string>>(savedGrants);
  const [denies, setDenies] = React.useState<Set<string>>(savedDenies);
  const [saving, setSaving] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [selectedId, setSelectedId] = React.useState(WORKSPACE_SECTION_ID);

  React.useEffect(() => setGrants(new Set(savedGrants)), [savedGrants]);
  React.useEffect(() => setDenies(new Set(savedDenies)), [savedDenies]);

  const sections = usePermissionSections(installedAppCodes);
  const visible = React.useMemo(() => filterSections(sections, search), [sections, search]);
  const selected = visible.find((s) => s.id === selectedId) ?? visible[0] ?? null;

  const inheritedSubject = React.useMemo(() => ({ permissions: inheritedPermissions }), [inheritedPermissions]);
  const inherits = React.useCallback(
    (key: string) => checkAppPermission(inheritedSubject, key, null).allowed,
    [inheritedSubject],
  );
  const grantList = React.useMemo(() => [...grants], [grants]);

  const stateOf = (key: string): CellState => {
    if (denies.has(key)) return 'deny';
    if (grants.has(key)) return 'allow';
    return 'inherit';
  };
  const effective = (key: string) => {
    const state = stateOf(key);
    if (state !== 'inherit') return state === 'allow';
    return inherits(key) || hasPermission(grantList, key);
  };

  const toggle = (key: string) => {
    const state = stateOf(key);
    const nextGrants = new Set(grants);
    const nextDenies = new Set(denies);
    nextGrants.delete(key);
    nextDenies.delete(key);
    if (state === 'inherit') {
      if (inherits(key)) nextDenies.add(key);
      else nextGrants.add(key);
    }
    setGrants(nextGrants);
    setDenies(nextDenies);
  };

  const resetSection = (section: PermissionSection) => {
    const keys = new Set(section.keys);
    setGrants(new Set([...grants].filter((k) => !keys.has(k))));
    setDenies(new Set([...denies].filter((k) => !keys.has(k))));
  };

  const overrideCount = (section: PermissionSection) =>
    section.keys.filter((k) => grants.has(k) || denies.has(k)).length;

  const hasChanges = !sameSet(grants, savedGrants) || !sameSet(denies, savedDenies);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave([...grants], [...denies]);
    } finally {
      setSaving(false);
    }
  };

  const stateLabel = (key: string) => {
    const state = stateOf(key);
    if (state === 'allow') return t('sweep.settings.appPermissions.allowed');
    if (state === 'deny') return t('sweep.settings.appPermissions.denied');
    return t('sweep.settings.appPermissions.inheritedFrom', { role: roleLabel });
  };

  const renderToggle = (perm: MatrixPermission, label: string) => {
    const state = stateOf(perm.key);
    const on = effective(perm.key);
    const Icon = state === 'deny' ? X : on ? Check : Minus;
    return (
      <button
        type="button"
        onClick={() => canManage && toggle(perm.key)}
        disabled={!canManage}
        aria-label={`${label}: ${stateLabel(perm.key)}`}
        title={`${perm.label} — ${stateLabel(perm.key)}`}
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded border transition-colors',
          canManage ? 'cursor-pointer' : 'cursor-default',
          state === 'inherit' && 'border-border/70 text-muted-foreground/70',
          state === 'inherit' && !on && 'text-muted-foreground/30',
          state === 'allow' && 'border-green-600/60 bg-green-600/10 text-green-700 dark:text-green-400',
          state === 'deny' && 'border-red-600/60 bg-red-600/10 text-red-700 dark:text-red-400',
        )}
      >
        <Icon className="h-3 w-3" strokeWidth={3} />
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">{t('sweep.settings.appPermissions.memberTitle')}</h3>
        <div className="flex items-center gap-2">
          <ExpandingSearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('sweep.settings.roleDetail.searchPermissionsPlaceholder')}
          />
          {canManage && hasChanges && (
            <Button size="sm" className="h-7 text-xs shadow-none" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
              {t('sweep.settings.appPermissions.save')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('sweep.settings.appPermissions.memberDescription', { role: roleLabel })}
      </p>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <LegendItem className="border-border/70 text-muted-foreground/70" icon={Check}>
          {t('sweep.settings.appPermissions.inheritedFrom', { role: roleLabel })}
        </LegendItem>
        <LegendItem className="border-green-600/60 bg-green-600/10 text-green-700 dark:text-green-400" icon={Check}>
          {t('sweep.settings.appPermissions.allowed')}
        </LegendItem>
        <LegendItem className="border-red-600/60 bg-red-600/10 text-red-700 dark:text-red-400" icon={X}>
          {t('sweep.settings.appPermissions.denied')}
        </LegendItem>
      </div>

      {!selected ? (
        <p className="text-sm text-muted-foreground">
          {t('sweep.settings.roleDetail.noPermissionsMatch', { query: search })}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
          <PermissionSectionNav
            sections={visible}
            selectedId={selected.id}
            onSelect={setSelectedId}
            badge={(s) => {
              const count = overrideCount(s);
              return count > 0 ? count : null;
            }}
          />
          <div className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <SectionIcon section={selected} className="h-4 w-4 shrink-0" />
                {selected.label}
              </h4>
              {canManage && overrideCount(selected) > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
                  onClick={() => resetSection(selected)}
                >
                  {t('sweep.settings.appPermissions.resetOverrides')}
                </Button>
              )}
            </div>
            <PermissionMatrixTable
              objects={selected.objects}
              renderCell={(perm, object, actionLabel) =>
                renderToggle(
                  perm,
                  t('sweep.settings.roleDetail.actionObjectLabel', { action: actionLabel, object: object.objectName }),
                )
              }
              renderExtra={(perm, object) => (
                <span className="flex items-center gap-1.5 text-sm">
                  {renderToggle(perm, `${extraActionLabel(perm.action)} ${object.objectName}`)}
                  <span className="text-muted-foreground">{extraActionLabel(perm.action)}</span>
                </span>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LegendItem({
  className,
  icon: Icon,
  children,
}: {
  className: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('flex h-4 w-4 items-center justify-center rounded border', className)}>
        <Icon className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
      {children}
    </span>
  );
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
