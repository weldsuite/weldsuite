'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Plus, Search, Pencil, Trash2, Loader2, Package, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { LucideIconPreview } from '@/components/lucide-icon-picker';
import { APP_CATEGORIES } from '@/components/app-form';
import { cn } from '@/lib/utils';
import type { AppCatalogEntry, AppCatalogStats } from '@/lib/apps-data';
import { updateApp, deleteApp, seedApps } from '@/actions/apps';

export function AppsList({
  apps,
  stats,
  initialSearch,
  initialCategory,
}: {
  apps: AppCatalogEntry[];
  stats: AppCatalogStats;
  initialSearch: string;
  initialCategory: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  const [category, setCategory] = useState(initialCategory);
  const [confirmDelete, setConfirmDelete] = useState<AppCatalogEntry | null>(null);
  const [confirmSeed, setConfirmSeed] = useState<'upsert' | 'insertMissing' | null>(null);
  const [isMutating, startMutation] = useTransition();

  function applyFilters(nextSearch: string, nextCategory: string) {
    const params = new URLSearchParams();
    if (nextSearch.trim()) params.set('search', nextSearch.trim());
    if (nextCategory) params.set('category', nextCategory);
    const qs = params.toString();
    router.push(qs ? `/apps?${qs}` : '/apps');
  }

  function togglePublished(app: AppCatalogEntry) {
    startMutation(async () => {
      const result = await updateApp(app.id, { isPublished: !app.isPublished });
      if (result.ok) {
        toast.success(app.isPublished ? 'Unpublished' : 'Published');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function toggleActive(app: AppCatalogEntry) {
    startMutation(async () => {
      const result = await updateApp(app.id, { isActive: !app.isActive });
      if (result.ok) {
        toast.success(app.isActive ? 'Deactivated' : 'Activated');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function performDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    startMutation(async () => {
      const result = await deleteApp(target.id);
      if (result.ok) {
        toast.success(`Deleted "${target.name}"`);
        setConfirmDelete(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function performSeed(mode: 'upsert' | 'insertMissing') {
    startMutation(async () => {
      const result = await seedApps(mode);
      if (result.ok) {
        const parts: string[] = [];
        if (result.data.inserted) parts.push(`${result.data.inserted} created`);
        if (result.data.updated) parts.push(`${result.data.updated} updated`);
        if (result.data.skipped) parts.push(`${result.data.skipped} skipped`);
        toast.success(`Catalog seeded: ${parts.join(', ') || 'no changes'}`);
        setConfirmSeed(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6 text-blue-600" />
              App Catalog
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage the apps shown in the App Store and onboarding.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmSeed('upsert')}
              disabled={isMutating}
              className="px-4 py-2 rounded-md border bg-background hover:bg-accent text-sm font-medium flex items-center gap-2 disabled:opacity-50"
              title="Refresh all catalog entries with curated copy"
            >
              {isMutating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Seed catalog
            </button>
            <Link
              href="/apps/new"
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              New app
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Active" value={stats.active} />
          <StatCard label="Published" value={stats.published} />
          <StatCard label="Inactive" value={stats.inactive} muted />
        </div>

        <form
          className="flex items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters(search, category);
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, code or description…"
              className="w-full pl-9 pr-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              applyFilters(search, e.target.value);
            }}
            className="px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All categories</option>
            {APP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-2 rounded-md border text-sm hover:bg-accent"
          >
            Apply
          </button>
        </form>

        <div className="rounded-lg border bg-card overflow-hidden">
          {apps.length === 0 ? (
            <div className="text-center py-16 text-sm text-muted-foreground">
              No apps found. Create one to get started.
            </div>
          ) : (
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-14" />
                <col />
                <col className="w-28" />
                <col className="w-36" />
                <col className="w-16" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-20" />
              </colgroup>
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Icon</th>
                  <th className="text-left font-medium px-4 py-2.5">Name</th>
                  <th className="text-left font-medium px-4 py-2.5">Code</th>
                  <th className="text-left font-medium px-4 py-2.5">Category</th>
                  <th className="text-left font-medium px-4 py-2.5">Order</th>
                  <th className="text-left font-medium px-4 py-2.5">Active</th>
                  <th className="text-left font-medium px-4 py-2.5">Published</th>
                  <th className="text-right font-medium px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {apps.map((app) => (
                  <tr key={app.id} className="hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center">
                        <LucideIconPreview name={app.icon} className="h-5 w-5" />
                      </div>
                    </td>
                    <td className="px-4 py-3 min-w-0">
                      <div className="font-medium text-sm truncate">{app.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {app.description}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs truncate">{app.code}</td>
                    <td className="px-4 py-3 text-xs truncate">{app.category}</td>
                    <td className="px-4 py-3 text-xs tabular-nums">{app.sortOrder}</td>
                    <td className="px-4 py-3">
                      <ToggleBadge
                        on={app.isActive}
                        onLabel="Active"
                        offLabel="Inactive"
                        onClick={() => toggleActive(app)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <ToggleBadge
                        on={app.isPublished}
                        onLabel="Published"
                        offLabel="Draft"
                        onClick={() => togglePublished(app)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/apps/${app.id}`}
                          className="p-1.5 rounded hover:bg-accent"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
                        <button
                          onClick={() => setConfirmDelete(app)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {confirmSeed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-popover rounded-lg shadow-xl border max-w-md w-full p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-blue-600" />
                Seed catalog with curated copy
              </h2>
              <p className="text-sm text-muted-foreground mt-2">
                The seed dataset includes 12 first-party WeldSuite apps with human-written
                descriptions, overviews, features, how-it-works steps, release dates, and resource
                links.
              </p>
              <div className="mt-3 rounded-md border bg-muted/30 p-3 text-xs space-y-2">
                <div>
                  <strong>Overwrite existing:</strong> replaces the content of every catalog entry
                  with the curated copy. Active/published flags are preserved.
                </div>
                <div>
                  <strong>Insert missing only:</strong> only creates entries that don&apos;t exist
                  yet. Existing entries are left untouched.
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmSeed(null)}
                disabled={isMutating}
                className="px-4 py-2 rounded-md text-sm hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => performSeed('insertMissing')}
                disabled={isMutating}
                className="px-4 py-2 rounded-md border text-sm hover:bg-accent disabled:opacity-50"
              >
                Insert missing only
              </button>
              <button
                onClick={() => performSeed('upsert')}
                disabled={isMutating}
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {isMutating ? 'Seeding…' : 'Overwrite existing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-popover rounded-lg shadow-xl border max-w-md w-full p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Delete &quot;{confirmDelete.name}&quot;?</h2>
              <p className="text-sm text-muted-foreground mt-1">
                This permanently deletes the catalog entry and any attached screenshots. Workspaces
                that installed this app will keep their data, but the entry will disappear from the
                App Store.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-md text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={performDelete}
                disabled={isMutating}
                className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {isMutating ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={cn('text-xs uppercase tracking-wide', muted ? 'text-muted-foreground' : 'text-muted-foreground')}>
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function ToggleBadge({
  on,
  onLabel,
  offLabel,
  onClick,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors',
        on
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'
          : 'bg-muted text-muted-foreground border-border hover:bg-muted-foreground/10',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
      {on ? onLabel : offLabel}
    </button>
  );
}
