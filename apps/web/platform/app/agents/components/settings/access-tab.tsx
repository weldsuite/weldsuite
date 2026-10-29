'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, Globe, Search, SquareTerminal, type LucideIcon } from 'lucide-react';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useAgentTools, useGrantablePermissions, type AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { BUILTIN_GRANTS } from '../agent-state';
import {
  buildAccessGroups,
  countUnlockedTools,
  countUsedGrants,
  grantedIn,
  holds,
  readToolPermissions,
  splitByToolUsage,
  toolPermissionKeys,
  type AccessGroup,
  type AccessObject,
} from './access-groups';
import { SettingsSection } from './general-tab';
import type { AgentForm } from './use-agent-form';

type ActionLabels = ReturnType<typeof getTranslations<'common'>>['agents']['detail']['settings']['access']['actions'];

function actionLabel(action: string, labels: ActionLabels): string {
  if (action in labels) return labels[action as keyof ActionLabels];
  return action.replace(/[:_]/g, ' ');
}

function BuiltinRow({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
}: Readonly<{ icon: LucideIcon; title: string; description: string; checked: boolean; onChange: (v: boolean) => void }>) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-accent/40">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-1" />
    </label>
  );
}

function ObjectRow({
  object,
  granted,
  toolKeys,
  onToggle,
}: Readonly<{
  object: AccessObject;
  granted: Set<string>;
  /** Permissions some agent tool needs; null while that is unknown. */
  toolKeys: ReadonlySet<string> | null;
  onToggle: (key: string) => void;
}>) {
  const t = getTranslations('common').agents.detail.settings.access;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
      <span className="text-sm">{object.label}</span>
      <div className="flex flex-wrap gap-1">
        {object.actions.map(({ key, action }) => {
          const on = holds(granted, key);
          const idle = toolKeys !== null && !toolKeys.has(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(key)}
              title={idle ? `${key} — ${t.noToolHint}` : key}
              className={cn(
                'rounded-md border px-2 py-0.5 text-xs transition-colors',
                on
                  ? 'border-foreground bg-foreground text-background'
                  : 'text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                idle && !on && 'border-dashed opacity-60',
                idle && on && 'opacity-70',
              )}
            >
              {actionLabel(action, t.actions)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GroupBlock({
  group,
  granted,
  toolKeys,
  defaultOpen,
  onToggle,
  onSetMany,
}: Readonly<{
  group: AccessGroup;
  granted: Set<string>;
  toolKeys: ReadonlySet<string> | null;
  defaultOpen: boolean;
  onToggle: (key: string) => void;
  onSetMany: (keys: string[], on: boolean) => void;
}>) {
  const t = getTranslations('common').agents.detail.settings.access;
  const [open, setOpen] = useState(defaultOpen);
  const keys = group.objects.flatMap((o) => o.actions.map((a) => a.key));
  const count = grantedIn(keys, granted).length;
  const readKeys = keys.filter((k) => k.endsWith(':read'));

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate text-sm font-medium">{group.label ?? t.workspaceGroup}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {count > 0 ? t.grantedCount.replace('{count}', String(count)) : t.noneGranted}
          </span>
        </button>
        {open && (
          <div className="flex shrink-0 gap-2 text-xs">
            {readKeys.length > 0 && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onSetMany(readKeys, true)}>
                {t.readAll}
              </button>
            )}
            {count > 0 && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onSetMany(keys, false)}>
                {t.clear}
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <div className="divide-y border-t px-3">
          {group.objects.map((object) => (
            <ObjectRow key={object.key} object={object} granted={granted} toolKeys={toolKeys} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Objects no agent tool uses yet, out of the way until asked for: granting
 * them is harmless but does nothing today.
 */
function UnusedBlock({
  groups,
  granted,
  toolKeys,
  defaultOpen,
  onToggle,
  onSetMany,
}: Readonly<{
  groups: AccessGroup[];
  granted: Set<string>;
  toolKeys: ReadonlySet<string> | null;
  defaultOpen: boolean;
  onToggle: (key: string) => void;
  onSetMany: (keys: string[], on: boolean) => void;
}>) {
  const t = getTranslations('common').agents.detail.settings.access;
  const [open, setOpen] = useState(defaultOpen);
  const keys = groups.flatMap((g) => g.objects.flatMap((o) => o.actions.map((a) => a.key)));
  const count = grantedIn(keys, granted).length;

  return (
    <div className="rounded-xl border border-dashed">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="truncate text-sm font-medium text-muted-foreground">{t.unusedTitle}</span>
        {count > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{t.grantedCount.replace('{count}', String(count))}</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-dashed px-2 py-2">
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t.unusedHint}</p>
          {groups.map((group) => (
            <GroupBlock
              key={`${group.id}-${defaultOpen ? 'q' : ''}`}
              group={group}
              granted={granted}
              toolKeys={toolKeys}
              defaultOpen={defaultOpen}
              onToggle={onToggle}
              onSetMany={onSetMany}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccessSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" data-testid="access-skeleton">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2 rounded-xl border px-3 py-3">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** What the current grants unlock, counted from the tools that need them. */
function unlockedLine(
  t: ReturnType<typeof getTranslations<'common'>>['agents']['detail']['settings']['access'],
  toolCount: number | null,
  usedGrants: number | null,
): string | null {
  if (toolCount !== null) {
    if (toolCount === 0) return t.toolsUnlockedNone;
    return (toolCount === 1 ? t.toolsUnlockedOne : t.toolsUnlocked).replace('{count}', String(toolCount));
  }
  if (usedGrants !== null) return t.grantsUsed.replace('{count}', String(usedGrants));
  return null;
}

export function AccessTab({ form, agent }: Readonly<{ form: AgentForm; agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents.detail.settings.access;
  const grantableQuery = useGrantablePermissions();
  const toolsQuery = useAgentTools();
  const [query, setQuery] = useState('');
  const permissions = form.values.permissions;
  const granted = useMemo(() => new Set(permissions), [permissions]);
  const loading = grantableQuery.isLoading || toolsQuery.isLoading;

  const catalog = toolsQuery.data;
  const grantable = grantableQuery.data;
  const toolKeys = useMemo(() => toolPermissionKeys(readToolPermissions(agent), catalog), [agent, catalog]);
  const groups = useMemo(() => buildAccessGroups(grantable ?? []), [grantable]);

  const { used, unused } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = q
      ? groups
          .map((g) => ({
            ...g,
            objects: g.objects.filter(
              (o) => o.label.toLowerCase().includes(q) || (g.label ?? '').toLowerCase().includes(q),
            ),
          }))
          .filter((g) => g.objects.length > 0)
      : groups;
    return splitByToolUsage(matching, toolKeys);
  }, [groups, query, toolKeys]);

  const toolCount = catalog ? countUnlockedTools(catalog, granted) : null;
  const usedGrants = toolKeys ? countUsedGrants(toolKeys, granted) : null;
  const summary = unlockedLine(t, toolCount, usedGrants);

  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(permissions);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    form.set('permissions', [...next]);
  };
  const toggle = (key: string) => setMany([key], !granted.has(key));

  return (
    <div className="space-y-8">
      <SettingsSection title={t.builtinTitle} description={t.builtinDescription}>
        <div className="space-y-2">
          <BuiltinRow
            icon={SquareTerminal}
            title={t.sandbox.title}
            description={t.sandbox.description}
            checked={granted.has(BUILTIN_GRANTS.sandbox)}
            onChange={(on) => setMany([BUILTIN_GRANTS.sandbox], on)}
          />
          <BuiltinRow
            icon={Globe}
            title={t.web.title}
            description={t.web.description}
            checked={granted.has(BUILTIN_GRANTS.web)}
            onChange={(on) => setMany([BUILTIN_GRANTS.web], on)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t.workspaceTitle} description={t.workspaceDescription}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-9 w-full rounded-lg border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/25"
            placeholder={t.search}
            value={query}
            disabled={loading}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {loading ? (
          <AccessSkeleton />
        ) : (
          <>
            <div className="space-y-2">
              {used.length === 0 && unused.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">{t.noMatch}</p>
              )}
              {used.map((group) => (
                <GroupBlock
                  key={`${group.id}-${query ? 'q' : ''}`}
                  group={group}
                  granted={granted}
                  toolKeys={toolKeys}
                  defaultOpen={Boolean(query)}
                  onToggle={toggle}
                  onSetMany={setMany}
                />
              ))}
              {unused.length > 0 && (
                <UnusedBlock
                  key={query ? 'q' : 'all'}
                  groups={unused}
                  granted={granted}
                  toolKeys={toolKeys}
                  defaultOpen={Boolean(query)}
                  onToggle={toggle}
                  onSetMany={setMany}
                />
              )}
            </div>
            {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
          </>
        )}
      </SettingsSection>
    </div>
  );
}
