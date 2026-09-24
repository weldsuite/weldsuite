/**
 * Per-app permission matrix — shared by the role editor and the member panel.
 *
 * Permissions are shown one app at a time: a section list (Workspace + every
 * installed app) and, for the selected section, an object × action table. An
 * object that lives in several apps (companies, people, …) appears in each of
 * them with its own app-qualified keys (`weldcrm:companies:read`), which is
 * how access can differ per app. Cell rendering is left to the caller: the
 * role editor renders checkboxes, the member panel inherit/allow/deny toggles.
 */

import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Settings } from 'lucide-react';
import { buildAppPermissionCatalog, normalizeAppCode } from '@weldsuite/permissions';
import type { ObjectDefinition } from '@weldsuite/permissions/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { AppIcon } from '@/components/app-icon';
import { cn } from '@/lib/utils';
import { STANDARD_ACTIONS, getActionLabels, type StandardAction } from '@/components/settings/permission-categories';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface MatrixPermission {
  /** Full key as stored, e.g. `weldcrm:companies:read` or `team:read`. */
  key: string;
  label: string;
  description?: string;
  /** Action part relative to the object, e.g. `read`, `scope:all`. */
  action: string;
}

export interface MatrixObject {
  object: string;
  objectName: string;
  perAction: Partial<Record<StandardAction, MatrixPermission>>;
  extras: MatrixPermission[];
  all: MatrixPermission[];
}

export interface PermissionSection {
  /** `workspace` or the canonical app code. */
  id: string;
  /** Canonical app code, null for the workspace section. */
  app: string | null;
  label: string;
  objects: MatrixObject[];
  /** Every permission key in the section (for counts and bulk actions). */
  keys: string[];
}

export const WORKSPACE_SECTION_ID = 'workspace';

function actionOf(key: string, object: string): string {
  const marker = `${object}:`;
  const idx = key.indexOf(marker);
  if (idx === -1) return key.split(':').slice(1).join(':') || 'read';
  return key.slice(idx + marker.length) || 'read';
}

function toMatrixObject(obj: ObjectDefinition): MatrixObject {
  const perAction: MatrixObject['perAction'] = {};
  const extras: MatrixPermission[] = [];
  const all: MatrixPermission[] = [];
  for (const p of obj.permissions) {
    const perm: MatrixPermission = {
      key: p.key,
      label: p.label,
      description: p.description,
      action: actionOf(p.key, obj.key),
    };
    all.push(perm);
    if ((STANDARD_ACTIONS as readonly string[]).includes(perm.action)) {
      perAction[perm.action as StandardAction] = perm;
    } else {
      extras.push(perm);
    }
  }
  return { object: obj.key, objectName: obj.label, perAction, extras, all };
}

function toSection(id: string, app: string | null, label: string, objects: ObjectDefinition[]): PermissionSection {
  const matrix = objects.map(toMatrixObject);
  return { id, app, label, objects: matrix, keys: matrix.flatMap((o) => o.all.map((p) => p.key)) };
}

/**
 * Workspace section + one section per app. When `installedAppCodes` is given
 * (platform or canonical codes), apps that aren't installed are left out.
 */
export function usePermissionSections(installedAppCodes?: readonly string[]): PermissionSection[] {
  const t = useTranslations();
  // Joined so a new array with the same codes doesn't rebuild the sections.
  const installedKey = installedAppCodes?.join('|');
  return React.useMemo(() => {
    const catalog = buildAppPermissionCatalog();
    const installed =
      installedKey !== undefined
        ? new Set(installedKey.split('|').map((code) => normalizeAppCode(code) ?? code))
        : null;
    const apps = catalog.apps
      .filter((entry) => !installed || installed.has(entry.app))
      .map((entry) => toSection(entry.app, entry.app, entry.label, entry.objects));
    return [
      toSection(WORKSPACE_SECTION_ID, null, t('sweep.settings.appPermissions.workspace'), catalog.workspace),
      ...apps,
    ];
  }, [installedKey, t]);
}

/**
 * Keep only objects whose name/key matches `query` (and sections that still
 * have some). `keys` is narrowed to the visible objects too, so bulk actions
 * (Grant all, Revoke all, Reset) never reach objects the search hides.
 */
export function filterSections(sections: PermissionSection[], query: string): PermissionSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((s) => {
      const sectionMatches = s.label.toLowerCase().includes(q);
      const objects = sectionMatches
        ? s.objects
        : s.objects.filter((o) => o.objectName.toLowerCase().includes(q) || o.object.toLowerCase().includes(q));
      return { ...s, objects, keys: objects.flatMap((o) => o.all.map((p) => p.key)) };
    })
    .filter((s) => s.objects.length > 0);
}

// ---------------------------------------------------------------------------
// Section list
// ---------------------------------------------------------------------------

/** Platform icon code for a canonical app code, where the two differ. */
const ICON_CODE: Record<string, string> = { weldsocial: 'social' };

export function SectionIcon({ section, className }: { section: PermissionSection; className?: string }) {
  if (!section.app) return <Settings className={cn('text-muted-foreground', className)} />;
  return <AppIcon icon={ICON_CODE[section.app] ?? section.app} className={className} />;
}

export function PermissionSectionNav({
  sections,
  selectedId,
  onSelect,
  badge,
}: {
  sections: PermissionSection[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Right-aligned summary per section, e.g. "4/12". */
  badge?: (section: PermissionSection) => React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <nav
      className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible"
      aria-label={t('sweep.settings.appPermissions.sectionsLabel')}
    >
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => onSelect(section.id)}
          aria-current={section.id === selectedId ? 'true' : undefined}
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
            section.id === selectedId
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          <SectionIcon section={section} className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">{section.label}</span>
          {badge && <span className="ml-2 text-xs tabular-nums text-muted-foreground">{badge(section)}</span>}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function PermissionMatrixTable({
  objects,
  renderCell,
  renderExtra,
  rowAction,
}: {
  objects: MatrixObject[];
  /** Cell for a standard action (View/Create/Edit/Delete/Manage). */
  renderCell: (perm: MatrixPermission, object: MatrixObject, actionLabel: string) => React.ReactNode;
  /** Inline control for a non-standard action (scope:all, reveal, …). */
  renderExtra: (perm: MatrixPermission, object: MatrixObject) => React.ReactNode;
  /** Optional control next to the object name (e.g. "Grant all"). */
  rowAction?: (object: MatrixObject) => React.ReactNode;
}) {
  const t = useTranslations();
  const actionLabels = React.useMemo(() => getActionLabels(t), [t]);
  const hasExtras = objects.some((o) => o.extras.length > 0);

  return (
    <div className="rounded-md border border-border/70 overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-background [&_tr]:border-border/70">
            <TableRow>
              <TableHead className="w-[220px] text-[13px]">{t('sweep.settings.roleDetail.object')}</TableHead>
              {STANDARD_ACTIONS.map((action) => (
                <TableHead key={action} className="w-[90px] text-center text-[13px]">
                  {actionLabels[action]}
                </TableHead>
              ))}
              {hasExtras && <TableHead className="text-[13px]">{t('sweep.settings.roleDetail.other')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {objects.map((object) => (
              <TableRow key={object.object} className="h-10 hover:bg-muted/30">
                <TableCell className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{object.objectName}</span>
                    {rowAction?.(object)}
                  </div>
                </TableCell>
                {STANDARD_ACTIONS.map((action) => {
                  const perm = object.perAction[action];
                  return (
                    <TableCell key={action} className="py-2 px-3 text-center">
                      <div className="flex items-center justify-center">
                        {perm ? (
                          renderCell(perm, object, actionLabels[action])
                        ) : (
                          <span className="text-muted-foreground/40 text-sm select-none">—</span>
                        )}
                      </div>
                    </TableCell>
                  );
                })}
                {hasExtras && (
                  <TableCell className="py-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {object.extras.map((perm) => (
                        <React.Fragment key={perm.key}>{renderExtra(perm, object)}</React.Fragment>
                      ))}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** "scope:all" → "Scope All" for the extras column. */
export function extraActionLabel(action: string): string {
  return action.replace(/[-:]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
