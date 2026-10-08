
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { LucideIcon } from 'lucide-react';
import {
  TrendingUp,
  GitBranch,
  Users,
  Briefcase,
  Target,
  Handshake,
  Layers,
  Building2,
  User,
  Star,
  Heart,
  Zap,
  Globe,
  Mail,
  Phone,
  Calendar,
  FileText,
  FolderOpen,
  ShoppingBag,
  CreditCard,
  Truck,
  Package,
  Tag,
} from 'lucide-react';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { coloredSquareColors, coloredSquareIcons } from '@/components/app-sidebar-layout';
import { PipelineTemplateDialog, type PipelineTemplate } from '../components/pipeline-template-dialog';
import { CreateListDialog } from '../components/create-list-dialog';
import { RenameDialog } from '../components/rename-dialog';
import { getTemplateStages } from '../components/pipeline-templates';
import { useRouter } from '@/lib/router';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useCreatePipeline,
  useUpdatePipeline,
  useDeletePipeline,
} from '@/hooks/queries/use-pipelines-queries';
import {
  useLists,
  useCreateList,
  useUpdateList,
  useDeleteList,
  type ListKind,
} from '@/hooks/queries/use-lists-queries';
import type { Pipeline, PipelineStage, Opportunity } from '@/lib/api/domains/weldcrm';

// Pipeline icons round-trip through the API as string names. The create
// dialog and the sidebar item menu both pick from `coloredSquareIcons`, so we
// derive the name<->component mapping from that exact set. Using a smaller,
// out-of-sync map meant any picked icon it didn't know about was saved as the
// default and rendered as a different icon after a refresh.
const PIPELINE_ICON_BY_NAME: Record<string, LucideIcon> = Object.fromEntries(
  coloredSquareIcons.map(({ label, value }) => [label, value]),
);

// Icon names stored before the picker and this registry were aligned. Kept
// resolvable so existing (or imported) pipelines don't silently change icon.
const LEGACY_PIPELINE_ICONS: Record<string, LucideIcon> = {
  TrendingUp,
  GitBranch,
  Handshake,
  Building2,
};

// Icon name to component mapping for list icons
const LIST_ICON_MAP: Record<string, LucideIcon> = {
  Building2,
  User,
  Users,
  Briefcase,
  Target,
  Layers,
  Star,
  Heart,
  Zap,
  Globe,
  Mail,
  Phone,
  Calendar,
  FileText,
  FolderOpen,
  ShoppingBag,
  CreditCard,
  Truck,
  Package,
  Tag,
};

function getListIconFromName(name?: string | null): LucideIcon {
  if (!name) return Building2;
  return LIST_ICON_MAP[name] || Building2;
}

// `CreateListDialog` is shared with pipeline creation and defaults its icon
// picker to the pipeline icon set's first entry (lucide's `Building`, not
// `Building2`) — that component isn't in LIST_ICON_MAP at all, so every new
// list that didn't get a manually-picked icon fell through to this
// function's fallback. Without a kind-aware fallback that always produced
// 'Building2', even for a brand-new person list. Falling back per `kind`
// fixes the default while leaving an explicit, matching icon pick alone.
function getListIconName(icon: LucideIcon, kind: ListKind = 'company'): string {
  for (const [name, component] of Object.entries(LIST_ICON_MAP)) {
    if (component === icon) return name;
  }
  return kind === 'person' ? 'User' : 'Building2';
}

function getIconFromName(name?: string | null): LucideIcon {
  if (!name) return TrendingUp;
  return PIPELINE_ICON_BY_NAME[name] ?? LEGACY_PIPELINE_ICONS[name] ?? TrendingUp;
}

function getIconName(icon: LucideIcon): string {
  return coloredSquareIcons.find((option) => option.value === icon)?.label ?? 'TrendingUp';
}

interface PageData {
  id: string;
  title: string;
  href: string;
  icon: LucideIcon;
  iconColor: string;
  /** Only populated for list pages, not pipeline pages. */
  kind?: ListKind;
}

/**
 * Creates a template's stages on a new pipeline. Each stage carries its own
 * position, so they are created in parallel.
 */
async function createTemplateStages(
  client: Awaited<ReturnType<ReturnType<typeof useAppApiClient>['getClient']>>,
  pipelineId: string,
  templateId: string,
): Promise<void> {
  await Promise.all(
    getTemplateStages(templateId).map((stageData, i) =>
      client.post('/pipeline-stages', {
        name: stageData.name,
        color: stageData.color,
        probability: stageData.probability,
        pipeline: pipelineId,
        position: i,
        isWon: stageData.isWon || false,
        isLost: stageData.isLost || false,
        isDefault: i === 0,
      }),
    ),
  );
}

export function useCrmSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
} {
  const t = useTranslations();
  const router = useRouter();
  const { getClient } = useAppApiClient();
  const createPipelineMutation = useCreatePipeline();
  const updatePipelineMutation = useUpdatePipeline();
  const deletePipelineMutation = useDeletePipeline();
  const createListMutation = useCreateList();
  const updateListMutation = useUpdateList();
  const deleteListMutation = useDeleteList();
  // All-kinds lists for the sidebar. Only enabled when the CRM module is
  // active, so other modules don't fire this query.
  const { data: sidebarListsResp } = useLists();

  const [customerPages, setCustomerPages] = React.useState<PageData[]>([]);
  const [pipelinePages, setPipelinePages] = React.useState<PageData[]>([]);
  const [templateDialogOpen, setTemplateDialogOpen] = React.useState(false);
  const [createListDialogOpen, setCreateListDialogOpen] = React.useState(false);
  const [createPipelineDialogOpen, setCreatePipelineDialogOpen] = React.useState(false);
  const [renameListDialogOpen, setRenameListDialogOpen] = React.useState(false);
  const [renamingList, setRenamingList] = React.useState<{ id: string; name: string; type: 'list' | 'pipeline' } | null>(null);
  const [listToDelete, setListToDelete] = React.useState<{ id: string; name: string; memberCount: number | null } | null>(null);
  const [deleteListPending, setDeleteListPending] = React.useState(false);
  const [pipelineToDelete, setPipelineToDelete] = React.useState<{ id: string; name: string; dealCount: number | null } | null>(null);
  const [deletePipelinePending, setDeletePipelinePending] = React.useState(false);

  // Fetch pipelines and lists when active
  React.useEffect(() => {
    if (!isActive) return;

    const fetchData = async () => {
      try {
        const client = await getClient();
        const pipelinesResult = await client.get<{ data?: Pipeline[] }>('/pipelines');

        const pipelines = pipelinesResult.data || [];
        if (pipelines.length) {
          setPipelinePages(
            pipelines.map((p) => ({
              id: p.id,
              title: p.name,
              href: `/weldcrm/pipeline/${p.id}`,
              icon: getIconFromName(p.icon),
              iconColor: p.color || 'bg-blue-500',
            }))
          );
        }
      } catch (error) {
        console.error('Failed to fetch sidebar data:', error);
      }
    };

    void fetchData();
  }, [isActive, getClient]);

  // Sync the sidebar lists from the React Query cache so create/update/delete
  // mutations propagate without an extra round-trip.
  React.useEffect(() => {
    if (!isActive) return;
    const lists = sidebarListsResp?.data;
    if (!lists) return;
    setCustomerPages(
      lists.map((list) => ({
        id: list.id,
        title: list.name,
        href: `/weldcrm/lists/${list.id}`,
        icon: getListIconFromName(list.icon),
        iconColor: list.color || 'bg-blue-500',
        kind: list.kind,
      }))
    );
  }, [isActive, sidebarListsResp]);

  // ===== CUSTOMER LIST HANDLERS =====
  const handleAddCustomerPage = () => {
    setCreateListDialogOpen(true);
  };

  const handleCreateList = async (
    name: string,
    color: string,
    icon: LucideIcon,
    kind: ListKind = 'company',
  ) => {
    const iconName = getListIconName(icon, kind);
    try {
      const result = await createListMutation.mutateAsync({
        name,
        color,
        icon: iconName,
        kind,
        type: 'static',
      });
      const created = result.data;
      if (created?.id) {
        toast.success(t('crm.sidebar.listCreated'));
        router.push(`/weldcrm/lists/${created.id}`);
      } else {
        toast.error(t('crm.sidebar.listCreateFailed'));
      }
    } catch (error) {
      console.error('Failed to create list:', error);
      toast.error(t('crm.sidebar.listCreateFailed'));
    }
  };

  const handleDeleteCustomerPage = async (pageId: string) => {
    try {
      await deleteListMutation.mutateAsync(pageId);
      setCustomerPages((prev) => prev.filter((p) => p.id !== pageId));
      toast.success(t('crm.sidebar.listDeleted'));
      router.push('/weldcrm/companies');
    } catch (error) {
      console.error('Failed to delete list:', error);
      toast.error(t('crm.sidebar.listDeleteFailed'));
    }
  };

  // Opens the delete confirmation for a sidebar list, looking up its current
  // member count first so the dialog can warn how many rows are affected.
  // Falls back to generic copy (no count) if the lookup fails.
  const handleRequestDeleteList = async (pageId: string) => {
    const page = customerPages.find((p) => p.id === pageId);
    if (!page) return;
    setListToDelete({ id: pageId, name: page.title, memberCount: null });
    try {
      const client = await getClient();
      const result = await client.get<{ data?: { memberCount?: number } }>(`/lists/${pageId}`);
      const memberCount = result.data?.memberCount;
      if (typeof memberCount === 'number') {
        setListToDelete((prev) => (prev?.id === pageId ? { ...prev, memberCount } : prev));
      }
    } catch (error) {
      console.error('Failed to load list member count:', error);
    }
  };

  const handleConfirmDeleteList = async () => {
    if (!listToDelete) return;
    setDeleteListPending(true);
    try {
      await handleDeleteCustomerPage(listToDelete.id);
      setListToDelete(null);
    } finally {
      setDeleteListPending(false);
    }
  };

  const handleDuplicateCustomerPage = async (pageId: string) => {
    const page = customerPages.find((p) => p.id === pageId);
    if (!page) return;
    const iconName = getListIconName(page.icon, page.kind ?? 'company');
    try {
      const result = await createListMutation.mutateAsync({
        name: `${page.title} (Copy)`,
        color: page.iconColor,
        icon: iconName,
        kind: page.kind ?? 'company',
        type: 'static',
      });
      const created = result.data;
      if (created?.id) {
        // No server-side duplicate endpoint exists yet — copy membership by
        // reading the source list's members and bulk-adding them to the new
        // one. A static list's members are a flat entityId set, so this is
        // a straight copy regardless of kind.
        try {
          const client = await getClient();
          const membersResult = await client.get<{ data?: Array<{ entityId: string }> }>(
            `/lists/${pageId}/members`,
          );
          const entityIds = (membersResult.data ?? []).map((m) => m.entityId);
          if (entityIds.length > 0) {
            await client.post(`/lists/${created.id}/members`, { entityIds });
          }
        } catch (membersError) {
          console.error('Failed to copy list members:', membersError);
          toast.error(t('crm.sidebar.listDuplicateMembersFailed'));
        }
        toast.success(t('crm.sidebar.listDuplicated'));
        router.push(`/weldcrm/lists/${created.id}`);
      } else {
        toast.error(t('crm.sidebar.listDuplicateFailed'));
      }
    } catch (error) {
      console.error('Failed to duplicate list:', error);
      toast.error(t('crm.sidebar.listDuplicateFailed'));
    }
  };

  const handleChangeCustomerColor = async (pageId: string, color: string) => {
    try {
      await updateListMutation.mutateAsync({ id: pageId, data: { color } });
      setCustomerPages((prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, iconColor: color } : p))
      );
    } catch (error) {
      console.error('Failed to update list color:', error);
      toast.error(t('crm.sidebar.listColorUpdateFailed'));
    }
  };

  const handleChangeCustomerIcon = async (pageId: string, icon: LucideIcon) => {
    const page = customerPages.find((p) => p.id === pageId);
    const iconName = getListIconName(icon, page?.kind ?? 'company');
    try {
      await updateListMutation.mutateAsync({ id: pageId, data: { icon: iconName } });
      setCustomerPages((prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, icon } : p))
      );
    } catch (error) {
      console.error('Failed to update list icon:', error);
      toast.error(t('crm.sidebar.listIconUpdateFailed'));
    }
  };

  const handleRenameCustomerList = (pageId: string) => {
    const page = customerPages.find((p) => p.id === pageId);
    if (!page) return;
    setRenamingList({ id: pageId, name: page.title, type: 'list' });
    setRenameListDialogOpen(true);
  };

  const handleConfirmRename = async (newName: string) => {
    if (!renamingList) return;
    try {
      if (renamingList.type === 'pipeline') {
        await updatePipelineMutation.mutateAsync({ id: renamingList.id, data: { name: newName } });
        setPipelinePages((prev) =>
          prev.map((p) => (p.id === renamingList.id ? { ...p, title: newName } : p))
        );
        toast.success(t('crm.sidebar.dealRenamed'));
      } else {
        await updateListMutation.mutateAsync({ id: renamingList.id, data: { name: newName } });
        setCustomerPages((prev) =>
          prev.map((p) => (p.id === renamingList.id ? { ...p, title: newName } : p))
        );
        toast.success(t('crm.sidebar.listRenamed'));
      }
    } catch (error) {
      console.error('Failed to rename:', error);
      toast.error(t('crm.sidebar.renameFailed'));
    }
  };

  const handleCustomerImport = () => {
    toast.info(t('crm.sidebar.importComingSoon'));
  };

  const handleCustomerExport = () => {
    toast.info(t('crm.sidebar.exportComingSoon'));
  };

  // ===== PIPELINE PAGE HANDLERS =====
  const handleAddPipeline = () => {
    setCreatePipelineDialogOpen(true);
  };

  const handleCreatePipeline = async (name: string, color: string, icon: LucideIcon) => {
    const iconName = getIconName(icon);
    try {
      const pipeline = await createPipelineMutation.mutateAsync({
        name,
        template: 'blank',
        color,
        icon: iconName,
      });
      if (pipeline?.id) {
        // Create template stages for the new pipeline
        const client = await getClient();
        await createTemplateStages(client, pipeline.id, 'blank');
        const newPage: PageData = {
          id: pipeline.id,
          title: pipeline.name,
          href: `/weldcrm/pipeline/${pipeline.id}`,
          icon: icon,
          iconColor: pipeline.color || color,
        };
        setPipelinePages((prev) => [...prev, newPage]);
        toast.success(t('crm.sidebar.dealCreated'));
        router.push(`/weldcrm/pipeline/${pipeline.id}`);
      } else {
        toast.error(t('crm.sidebar.dealCreateFailed'));
      }
    } catch (error) {
      console.error('Failed to create deal:', error);
      toast.error(t('crm.sidebar.dealCreateFailed'));
    }
  };

  const handleSelectTemplate = async (template: PipelineTemplate) => {
    const newPipelineName =
      template.id === 'blank' ? `Pipeline ${pipelinePages.length}` : template.name;
    const colorIndex = pipelinePages.length % coloredSquareColors.length;
    const color = coloredSquareColors[colorIndex].value;
    try {
      const pipeline = await createPipelineMutation.mutateAsync({
        name: newPipelineName,
        template: template.id,
        color,
      });
      if (pipeline?.id) {
        // Create template stages for the new pipeline
        const client = await getClient();
        await createTemplateStages(client, pipeline.id, template.id);
        const newPage: PageData = {
          id: pipeline.id,
          title: pipeline.name,
          href: `/weldcrm/pipeline/${pipeline.id}`,
          icon: TrendingUp,
          iconColor: pipeline.color || color,
        };
        setPipelinePages((prev) => [...prev, newPage]);
        toast.success(t('crm.sidebar.dealCreated'));
        router.push(`/weldcrm/pipeline/${pipeline.id}`);
      } else {
        toast.error(t('crm.sidebar.dealCreateFailed'));
      }
    } catch (error) {
      console.error('Failed to create deal:', error);
      toast.error(t('crm.sidebar.dealCreateFailed'));
    }
  };

  const handleDeletePipelinePage = async (pageId: string) => {
    if (pageId === 'all-pipelines') return;
    try {
      await deletePipelineMutation.mutateAsync(pageId);
      // `/weldcrm` is the My Tasks board, not a CRM landing page — landing
      // there after deleting a pipeline was disorienting. Prefer another
      // remaining pipeline; fall back to Companies (a real CRM home) only
      // when none are left.
      const remaining = pipelinePages.filter((p) => p.id !== pageId);
      setPipelinePages(remaining);
      toast.success(t('crm.sidebar.dealDeleted'));
      if (remaining[0]) {
        router.push(`/weldcrm/pipeline/${remaining[0].id}`);
      } else {
        router.push('/weldcrm/companies');
      }
    } catch (error) {
      console.error('Failed to delete pipeline:', error);
      toast.error(t('crm.sidebar.dealDeleteFailed'));
    }
  };

  // Opens the delete confirmation for a sidebar pipeline, looking up its
  // current deal count first so the dialog can warn how many deals are
  // affected. Falls back to generic copy (no count) if the lookup fails.
  const handleRequestDeletePipeline = async (pageId: string) => {
    if (pageId === 'all-pipelines') return;
    const page = pipelinePages.find((p) => p.id === pageId);
    if (!page) return;
    setPipelineToDelete({ id: pageId, name: page.title, dealCount: null });
    try {
      const client = await getClient();
      const result = await client.get<{ pagination?: { totalCount?: number } }>(
        `/opportunities?pipeline=${encodeURIComponent(pageId)}&limit=1`,
      );
      const dealCount = result.pagination?.totalCount;
      if (typeof dealCount === 'number') {
        setPipelineToDelete((prev) => (prev?.id === pageId ? { ...prev, dealCount } : prev));
      }
    } catch (error) {
      console.error('Failed to load pipeline deal count:', error);
    }
  };

  const handleConfirmDeletePipeline = async () => {
    if (!pipelineToDelete) return;
    setDeletePipelinePending(true);
    try {
      await handleDeletePipelinePage(pipelineToDelete.id);
      setPipelineToDelete(null);
    } finally {
      setDeletePipelinePending(false);
    }
  };

  const handleDuplicatePipelinePage = async (pageId: string) => {
    if (pageId === 'all-pipelines') return;
    const page = pipelinePages.find((p) => p.id === pageId);
    if (!page) return;
    try {
      const client = await getClient();
      // Get original pipeline details
      const originalResult = await client.get<{ data?: Pipeline }>(`/pipelines/${pageId}`);
      if (!originalResult.data) {
        toast.error(t('crm.sidebar.pipelineNotFound'));
        return;
      }
      const original = originalResult.data;
      // Create new pipeline
      const pipeline = await createPipelineMutation.mutateAsync({
        name: `${page.title} (Copy)`,
        color: original.color,
        icon: original.icon,
        template: original.template,
        description: original.description,
      });
      if (pipeline?.id) {
        // Copy stages
        const stagesResult = await client.get<{ data?: PipelineStage[] }>(`/pipeline-stages?pipeline=${pageId}`);
        if (stagesResult.data) {
          // Each copy keeps the original's position, so they can be created in parallel.
          await Promise.all(
            stagesResult.data.map((stage) =>
              client.post('/pipeline-stages', {
                name: stage.name,
                color: stage.color,
                probability: stage.probability,
                pipeline: pipeline.id,
                position: stage.position,
                isWon: stage.isWon || false,
                isLost: stage.isLost || false,
                isDefault: stage.isDefault || false,
                description: stage.description,
              }),
            ),
          );
        }
        const newPage: PageData = {
          id: pipeline.id,
          title: pipeline.name,
          href: `/weldcrm/pipeline/${pipeline.id}`,
          icon: TrendingUp,
          iconColor: pipeline.color || page.iconColor,
        };
        setPipelinePages((prev) => [...prev, newPage]);
        toast.success(t('crm.sidebar.dealDuplicated'));
        router.push(`/weldcrm/pipeline/${pipeline.id}`);
      } else {
        toast.error(t('crm.sidebar.dealDuplicateFailed'));
      }
    } catch (error) {
      console.error('Failed to duplicate pipeline:', error);
      toast.error(t('crm.sidebar.dealDuplicateFailed'));
    }
  };

  const handleChangePipelineColor = async (pageId: string, color: string) => {
    if (pageId === 'all-pipelines') return;
    try {
      await updatePipelineMutation.mutateAsync({ id: pageId, data: { color } });
      setPipelinePages((prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, iconColor: color } : p))
      );
    } catch (error) {
      console.error('Failed to update pipeline color:', error);
      toast.error(t('crm.sidebar.dealColorUpdateFailed'));
    }
  };

  const handleChangePipelineIcon = async (pageId: string, icon: LucideIcon) => {
    if (pageId === 'all-pipelines') return;
    const iconName = getIconName(icon);
    try {
      await updatePipelineMutation.mutateAsync({ id: pageId, data: { icon: iconName } });
      setPipelinePages((prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, icon } : p))
      );
    } catch (error) {
      console.error('Failed to update pipeline icon:', error);
      toast.error(t('crm.sidebar.dealIconUpdateFailed'));
    }
  };

  const handleRenamePipeline = (pageId: string) => {
    const page = pipelinePages.find((p) => p.id === pageId);
    if (!page) return;
    setRenamingList({ id: pageId, name: page.title, type: 'pipeline' });
    setRenameListDialogOpen(true);
  };

  const handlePipelineImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.pipeline || !data.stages) {
          toast.error(t('crm.sidebar.invalidPipelineFile'));
          return;
        }
        // Create the pipeline
        const pipeline = await createPipelineMutation.mutateAsync({
          name: data.pipeline.name,
          description: data.pipeline.description,
          color: data.pipeline.color,
          icon: data.pipeline.icon,
        });
        if (pipeline?.id) {
          // Create the stages
          const client = await getClient();
          for (let i = 0; i < data.stages.length; i++) {
            const stageData = data.stages[i];
            await client.post('/pipeline-stages', {
              name: stageData.name,
              description: stageData.description,
              color: stageData.color,
              probability: stageData.probability || 50,
              pipeline: pipeline.id,
              position: stageData.position ?? i,
              isDefault: stageData.isDefault || i === 0,
              isWon: stageData.isWon || false,
              isLost: stageData.isLost || false,
            });
          }
          const newPage: PageData = {
            id: pipeline.id,
            title: pipeline.name,
            href: `/weldcrm/pipeline/${pipeline.id}`,
            icon: getIconFromName(pipeline.icon),
            iconColor: pipeline.color || 'bg-blue-500',
          };
          setPipelinePages((prev) => [...prev, newPage]);
          toast.success(t('crm.sidebar.dealImported'));
          router.push(`/weldcrm/pipeline/${pipeline.id}`);
        } else {
          toast.error(t('crm.sidebar.dealImportFailed'));
        }
      } catch (error) {
        console.error('Failed to import pipeline:', error);
        toast.error(t('crm.sidebar.pipelineParseError'));
      }
    };
    input.click();
  };

  const handlePipelineExport = async (pageId: string) => {
    if (pageId === 'all-pipelines') {
      toast.info(t('crm.sidebar.cannotExportAll'));
      return;
    }
    try {
      const client = await getClient();
      // Get pipeline, stages, and deals
      const [pipelineResult, stagesResult, dealsResult] = await Promise.all([
        client.get<{ data?: Pipeline }>(`/pipelines/${pageId}`),
        client.get<{ data?: PipelineStage[] }>(`/pipeline-stages?pipeline=${pageId}`),
        client.get<{ data?: Opportunity[] }>(`/opportunities?pipeline=${pageId}`),
      ]);
      if (!pipelineResult.data) {
        toast.error(t('crm.sidebar.pipelineNotFound'));
        return;
      }
      const pipeline = pipelineResult.data;
      const stages = stagesResult.data || [];
      const deals = dealsResult.data || [];
      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        pipeline: {
          name: pipeline.name,
          description: pipeline.description,
          color: pipeline.color,
          icon: pipeline.icon,
          template: pipeline.template,
        },
        stages: stages.map((stage) => ({
          name: stage.name,
          description: stage.description,
          color: stage.color,
          probability: stage.probability,
          position: stage.position,
          isDefault: stage.isDefault,
          isWon: stage.isWon,
          isLost: stage.isLost,
        })),
        deals: deals.map((deal) => ({
          name: deal.name,
          description: deal.description,
          amount: deal.amount,
          currency: deal.currency,
          stage: deal.stage,
          probability: deal.probability,
          status: deal.status,
          closeDate: deal.closeDate,
          tags: deal.tags,
        })),
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pipeline-${exportData.pipeline.name.toLowerCase().replaceAll(/\s+/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('crm.sidebar.dealExported'));
    } catch (error) {
      console.error('Failed to export pipeline:', error);
      toast.error(t('crm.sidebar.dealExportFailed'));
    }
  };

  if (!isActive) {
    return { menuGroups: [], dialogs: null };
  }

  // Transform customer pages to menu items
  const customerItems: MenuItemProps[] = customerPages.map((page) => ({
    title: page.title,
    href: page.href,
    icon: page.icon,
    iconStyle: 'colored-square' as const,
    iconColor: page.iconColor,
    id: page.id,
    onDelete: () => handleRequestDeleteList(page.id),
    onDuplicate: () => handleDuplicateCustomerPage(page.id),
    onRename: () => handleRenameCustomerList(page.id),
    onChangeColor: (color: string) => handleChangeCustomerColor(page.id, color),
    onChangeIcon: (icon: LucideIcon) => handleChangeCustomerIcon(page.id, icon),
    onImport: () => handleCustomerImport(),
    onExport: () => handleCustomerExport(),
  }));

  // Transform pipeline pages to menu items
  const pipelineItems: MenuItemProps[] = pipelinePages.map((page) => ({
    title: page.title,
    href: page.href,
    icon: page.icon,
    iconStyle: 'colored-square' as const,
    iconColor: page.iconColor,
    id: page.id,
    onDelete: () => handleRequestDeletePipeline(page.id),
    onDuplicate: () => handleDuplicatePipelinePage(page.id),
    onRename: () => handleRenamePipeline(page.id),
    onChangeColor: (color: string) => handleChangePipelineColor(page.id, color),
    onChangeIcon: (icon: LucideIcon) => handleChangePipelineIcon(page.id, icon),
    onImport: () => handlePipelineImport(),
    onExport: () => handlePipelineExport(page.id),
  }));

  const menuGroups: MenuGroupProps[] = [
    {
      group: t('crm.sidebar.lists'),
      items: customerItems,
      onAdd: handleAddCustomerPage,
      // Keep the header + empty-state "Add" button visible after the last list
      // is deleted, so the user can still create a new one from the sidebar.
      keepWhenEmpty: true,
      addLabel: t('crm.sidebar.addList'),
    },
    {
      group: t('crm.sidebar.deals'),
      items: pipelineItems,
      onAdd: handleAddPipeline,
      // Keep the header + empty-state "Add" button visible after the last
      // pipeline is deleted, otherwise the whole Deals section disappears.
      keepWhenEmpty: true,
      addLabel: t('crm.sidebar.addPipeline'),
    },
  ];

  const listMemberCount = listToDelete?.memberCount;
  let deleteListDescription = t('crm.sidebar.deleteListDescriptionGeneric');
  if (listMemberCount === 1) {
    deleteListDescription = t('crm.sidebar.deleteListDescriptionWithMembersSingular');
  } else if (listMemberCount != null) {
    deleteListDescription = t('crm.sidebar.deleteListDescriptionWithMembersPlural', { count: listMemberCount });
  }

  const pipelineDealCount = pipelineToDelete?.dealCount;
  let deletePipelineDescription = t('crm.sidebar.deletePipelineDescriptionGeneric');
  if (pipelineDealCount === 1) {
    deletePipelineDescription = t('crm.sidebar.deletePipelineDescriptionWithDealsSingular');
  } else if (pipelineDealCount != null) {
    deletePipelineDescription = t('crm.sidebar.deletePipelineDescriptionWithDealsPlural', { count: pipelineDealCount });
  }

  const dialogs = (
    <>
      <PipelineTemplateDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        onSelectTemplate={handleSelectTemplate}
      />
      <CreateListDialog
        open={createListDialogOpen}
        onOpenChange={setCreateListDialogOpen}
        onCreateList={handleCreateList}
        showKindSelector
      />
      <CreateListDialog
        open={createPipelineDialogOpen}
        onOpenChange={setCreatePipelineDialogOpen}
        onCreateList={handleCreatePipeline}
        title={t('crm.sidebar.createNewPipeline')}
        buttonLabel={t('crm.sidebar.createPipeline')}
        placeholder={t('crm.sidebar.myPipeline')}
      />
      <RenameDialog
        open={renameListDialogOpen}
        onOpenChange={setRenameListDialogOpen}
        currentName={renamingList?.name || ''}
        onRename={handleConfirmRename}
      />
      <ConfirmDialog
        open={!!listToDelete}
        onOpenChange={(open) => {
          if (!open) setListToDelete(null);
        }}
        title={t('crm.sidebar.deleteListTitle', { name: listToDelete?.name ?? '' })}
        description={deleteListDescription}
        variant="destructive"
        confirmLabel={t('crm.sidebar.deleteListConfirm')}
        loading={deleteListPending}
        onConfirm={handleConfirmDeleteList}
      />
      <ConfirmDialog
        open={!!pipelineToDelete}
        onOpenChange={(open) => {
          if (!open) setPipelineToDelete(null);
        }}
        title={t('crm.sidebar.deletePipelineTitle', { name: pipelineToDelete?.name ?? '' })}
        description={deletePipelineDescription}
        variant="destructive"
        confirmLabel={t('crm.sidebar.deletePipelineConfirm')}
        loading={deletePipelinePending}
        onConfirm={handleConfirmDeletePipeline}
      />
    </>
  );

  return { menuGroups, dialogs };
}
