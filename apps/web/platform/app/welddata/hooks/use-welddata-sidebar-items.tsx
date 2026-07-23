import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { LucideIcon } from 'lucide-react';
import { Database } from 'lucide-react';
import { toast } from 'sonner';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { coloredSquareIcons } from '@/components/app-sidebar-layout';
import { CreateListDialog } from '@/app/weldcrm/components/create-list-dialog';
import { RenameDialog } from '@/app/weldcrm/components/rename-dialog';
import { useRouter, usePathname } from '@/lib/router';
import {
  useWelddataLists,
  useCreateWelddataList,
  useUpdateWelddataList,
  useDeleteWelddataList,
} from '@/hooks/queries/use-welddata-queries';

// Icons round-trip through the API as string names. Derive the name<->component
// mapping from the same set the create dialog offers, so a picked icon survives
// a refresh.
const ICON_BY_NAME: Record<string, LucideIcon> = Object.fromEntries(
  coloredSquareIcons.map(({ label, value }) => [label, value]),
);

function iconFromName(name?: string | null): LucideIcon {
  return (name && ICON_BY_NAME[name]) || Database;
}

function iconToName(icon: LucideIcon): string {
  return coloredSquareIcons.find((o) => o.value === icon)?.label ?? 'Database';
}

/**
 * WeldData "Lists" sidebar section — mirrors the CRM lists pattern: the
 * workspace's lead lists rendered as colored-square menu items, with an "add"
 * button plus per-item rename / recolor / change-icon / delete. The lists query
 * only runs while the WeldData module is active.
 */
export function useWelddataSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  const { data: listsResp } = useWelddataLists(undefined, isActive);
  const createList = useCreateWelddataList();
  const updateList = useUpdateWelddataList();
  const deleteList = useDeleteWelddataList();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);

  const lists = listsResp?.data ?? [];

  const handleCreate = async (
    name: string,
    color: string,
    icon: LucideIcon,
    kind?: 'person' | 'company',
  ) => {
    try {
      const created = await createList.mutateAsync({
        name,
        kind: kind ?? 'person',
        color,
        icon: iconToName(icon),
      });
      if (created?.id) {
        toast.success(t('welddata.toasts.listCreated'));
        router.push(`/welddata/lists/${created.id}`);
      }
    } catch {
      toast.error(t('welddata.toasts.searchFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteList.mutateAsync(id);
      toast.success(t('welddata.toasts.listDeleted'));
      if (pathname.includes(`/welddata/lists/${id}`)) router.push('/welddata');
    } catch {
      toast.error(t('welddata.toasts.searchFailed'));
    }
  };

  const handleChangeColor = async (id: string, color: string) => {
    try {
      await updateList.mutateAsync({ id, data: { color } });
    } catch {
      toast.error(t('welddata.toasts.searchFailed'));
    }
  };

  const handleChangeIcon = async (id: string, icon: LucideIcon) => {
    try {
      await updateList.mutateAsync({ id, data: { icon: iconToName(icon) } });
    } catch {
      toast.error(t('welddata.toasts.searchFailed'));
    }
  };

  const handleConfirmRename = async (newName: string) => {
    if (!renaming) return;
    try {
      await updateList.mutateAsync({ id: renaming.id, data: { name: newName } });
      toast.success(t('welddata.toasts.listUpdated'));
    } catch {
      toast.error(t('welddata.toasts.searchFailed'));
    }
  };

  if (!isActive) {
    return { menuGroups: [], dialogs: null };
  }

  const listItems: MenuItemProps[] = lists.map((list) => ({
    id: list.id,
    title: list.name,
    href: `/welddata/lists/${list.id}`,
    icon: iconFromName(list.icon),
    iconStyle: 'colored-square' as const,
    iconColor: list.color || 'bg-blue-500',
    onRename: () => {
      setRenaming({ id: list.id, name: list.name });
      setRenameOpen(true);
    },
    onChangeColor: (color: string) => handleChangeColor(list.id, color),
    onChangeIcon: (icon: LucideIcon) => handleChangeIcon(list.id, icon),
    onDelete: () => handleDelete(list.id),
  }));

  const menuGroups: MenuGroupProps[] = [
    {
      group: t('welddata.lists'),
      items: listItems,
      onAdd: () => setCreateOpen(true),
      keepWhenEmpty: true,
      addLabel: t('welddata.listsPage.create'),
    },
  ];

  const dialogs = (
    <>
      <CreateListDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreateList={handleCreate}
        showKindSelector
        title={t('welddata.listsPage.createDialogTitle')}
        buttonLabel={t('welddata.listsPage.create')}
        placeholder={t('welddata.listsPage.namePlaceholder')}
      />
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        currentName={renaming?.name ?? ''}
        onRename={handleConfirmRename}
      />
    </>
  );

  return { menuGroups, dialogs };
}
