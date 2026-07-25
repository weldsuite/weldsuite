'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Plus, Search, Pencil, Trash2, Loader2, Package, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { LucideIconPreview } from '@/components/lucide-icon-picker';
import { APP_CATEGORIES } from '@/components/app-form';
import { cn } from '@/lib/utils';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import type { AppCatalogEntry, AppCatalogStats } from '@/lib/apps-data';
import { updateApp, deleteApp, seedApps } from '@/actions/apps';

/** Sentinel for "no category filter" — Radix Select can't take an empty value. */
const ALL_CATEGORIES = '__all__';

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
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              App Catalog
            </span>
          }
          description="Manage the apps shown in the App Store and onboarding."
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmSeed('upsert')}
                disabled={isMutating}
                title="Refresh all catalog entries with curated copy"
              >
                {isMutating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Seed catalog
              </Button>
              <Button size="sm" asChild>
                <Link href="/apps/new">
                  <Plus className="h-4 w-4" />
                  New app
                </Link>
              </Button>
            </>
          }
        />

        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Active" value={stats.active} />
          <StatCard label="Published" value={stats.published} />
          <StatCard label="Inactive" value={stats.inactive} />
        </div>

        <div className="space-y-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyFilters(search, category);
            }}
          >
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, code or description…"
                className="h-8 pl-9"
              />
            </div>
            <Select
              value={category || ALL_CATEGORIES}
              onValueChange={(value) => {
                const next = value === ALL_CATEGORIES ? '' : value;
                setCategory(next);
                applyFilters(search, next);
              }}
            >
              <SelectTrigger size="sm" className="w-48">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                {APP_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" size="sm" className="h-8">
              Apply
            </Button>
          </form>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="w-14 text-[13.5px]">Icon</TableHead>
                  <TableHead className="text-[13.5px]">Name</TableHead>
                  <TableHead className="w-28 text-[13.5px]">Code</TableHead>
                  <TableHead className="w-36 text-[13.5px]">Category</TableHead>
                  <TableHead className="w-16 text-right text-[13.5px]">Order</TableHead>
                  <TableHead className="w-24 text-[13.5px]">Active</TableHead>
                  <TableHead className="w-28 text-[13.5px]">Published</TableHead>
                  <TableHead className="w-20 text-right text-[13.5px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {apps.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-16 text-center text-sm text-muted-foreground"
                    >
                      No apps found. Create one to get started.
                    </TableCell>
                  </TableRow>
                )}
                {apps.map((app) => (
                  <TableRow key={app.id} className="group hover:bg-muted/50">
                    <TableCell className="py-2">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                        <LucideIconPreview name={app.icon} className="h-5 w-5" />
                      </div>
                    </TableCell>
                    <TableCell className="min-w-0 py-2">
                      <div className="truncate text-sm font-medium">{app.name}</div>
                      <div className="max-w-md truncate text-xs text-muted-foreground">
                        {app.description}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs">{app.code}</TableCell>
                    <TableCell className="py-2 text-xs">{app.category}</TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      {app.sortOrder}
                    </TableCell>
                    <TableCell className="py-2">
                      <ToggleBadge
                        on={app.isActive}
                        onLabel="Active"
                        offLabel="Inactive"
                        onClick={() => toggleActive(app)}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <ToggleBadge
                        on={app.isPublished}
                        onLabel="Published"
                        offLabel="Draft"
                        onClick={() => togglePublished(app)}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" asChild title="Edit">
                          <Link href={`/apps/${app.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Delete"
                          onClick={() => setConfirmDelete(app)}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>

      <Dialog open={confirmSeed !== null} onOpenChange={(open) => !open && setConfirmSeed(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Seed catalog with curated copy
            </DialogTitle>
            <DialogDescription>
              The seed dataset includes 12 first-party WeldSuite apps with human-written
              descriptions, overviews, features, how-it-works steps, release dates, and resource
              links.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
            <div>
              <strong>Overwrite existing:</strong> replaces the content of every catalog entry with
              the curated copy. Active/published flags are preserved.
            </div>
            <div>
              <strong>Insert missing only:</strong> only creates entries that don&apos;t exist yet.
              Existing entries are left untouched.
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" disabled={isMutating} onClick={() => setConfirmSeed(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={isMutating}
              onClick={() => performSeed('insertMissing')}
            >
              Insert missing only
            </Button>
            <Button disabled={isMutating} onClick={() => performSeed('upsert')}>
              {isMutating ? 'Seeding…' : 'Overwrite existing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{confirmDelete?.name}&quot;?</DialogTitle>
            <DialogDescription>
              This permanently deletes the catalog entry and any attached screenshots. Workspaces
              that installed this app will keep their data, but the entry will disappear from the
              App Store.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={isMutating} onClick={performDelete}>
              {isMutating ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
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
    <button type="button" onClick={onClick}>
      <Badge
        variant={on ? 'success' : 'secondary'}
        className={cn('gap-1.5 transition-colors', on ? 'hover:bg-emerald-500/20' : 'hover:bg-secondary/80')}
      >
        <span
          className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
        />
        {on ? onLabel : offLabel}
      </Badge>
    </button>
  );
}
