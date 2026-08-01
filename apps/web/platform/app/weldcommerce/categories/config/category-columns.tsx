import { Badge } from '@weldsuite/ui/components/badge';
import { CornerDownRight } from 'lucide-react';
import type { ColumnDef } from '@/components/panel-entity-list';
import type { CommerceCategory } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';

/**
 * `showHierarchy` is on when the list is tree-ordered (no active search), so
 * the name cell can indent by depth and mark children. Search results are a
 * flat match set where an indent would imply a nesting the list doesn't have.
 */
export function buildCategoryColumns(showHierarchy: boolean): ColumnDef<CommerceCategory>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: 'flex-1',
      render: (c) => {
        const depth = showHierarchy ? c.depth ?? 0 : 0;
        return (
          <span
            className="flex min-w-0 items-center gap-1.5"
            style={{ paddingLeft: depth * 20 }}
          >
            {depth > 0 && (
              <CornerDownRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
                aria-hidden="true"
              />
            )}
            <span className="truncate font-medium">{c.name}</span>
          </span>
        );
      },
    },
    {
      id: 'slug',
      header: t.fields.slug,
      width: 'w-[180px]',
      render: (c) => <span className="text-muted-foreground truncate block">{c.slug ?? '—'}</span>,
    },
    {
      id: 'type',
      header: t.fields.type,
      width: 'w-[130px]',
      render: (c) => (
        <Badge variant="outline">
          {c.type === 'automated' ? t.categoryType.automated : t.categoryType.manual}
        </Badge>
      ),
    },
    {
      id: 'position',
      header: t.fields.position,
      width: 'w-[100px]',
      render: (c) => <span className="text-muted-foreground">{c.position ?? 0}</span>,
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'w-[120px]',
      render: (c) => (
        <Badge variant={c.isActive === false ? 'secondary' : 'default'}>
          {c.isActive === false ? t.status.inactive : t.status.active}
        </Badge>
      ),
    },
  ];
}
