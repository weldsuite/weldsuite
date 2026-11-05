import {
  BarChart3,
  Crosshair,
  File,
  Folder,
  GanttChart,
  Gavel,
  Settings,
  ShieldAlert,
  SquareCheck,
  SquareDashedMousePointer,
  SquareKanban,
  Table2,
  Target,
  Timer,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  PROJECT_TAB_IDS,
  hasTabRestrictions,
  hiddenProjectTabs,
  type ProjectTabId,
} from '@weldsuite/app-api-client/schemas/project-tabs';
import { useI18n } from '@/lib/i18n/provider';
import { useUser } from '@/lib/auth';
import { isModuleOffered } from '@/lib/edition';
import { useProjectTabSettings } from '@/hooks/queries/use-project-tab-settings';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';

export interface ProjectTabDef {
  id: ProjectTabId;
  name: string;
  /** Relative to the project, e.g. `/tasks`. */
  href: string;
  icon: LucideIcon;
}

const TAB_ICONS: Record<ProjectTabId, LucideIcon> = {
  tasks: SquareCheck,
  gantt: GanttChart,
  table: Table2,
  whiteboard: SquareDashedMousePointer,
  workload: Users,
  files: Folder,
  timesheet: Timer,
  pipeline: SquareKanban,
  documents: File,
  goals: Target,
  raid: ShieldAlert,
  governance: Gavel,
  scope: Crosshair,
  finance: Wallet,
  analytics: BarChart3,
  settings: Settings,
};

/**
 * Every project tab this deployment offers, in the default order, with its
 * translated name (derived at render time, so it follows the locale). The
 * Sheets tab (`table`) opens WeldSheets: left out where it is not offered.
 */
export function useProjectTabDefs(): ProjectTabDef[] {
  const { t } = useI18n();
  const names = t.projects.projectLayout.tabs;
  const label: Record<ProjectTabId, string> = {
    tasks: names.tasks,
    gantt: names.gantt,
    table: names.sheets,
    whiteboard: names.whiteboard,
    workload: names.workload,
    files: names.files,
    timesheet: names.timesheet,
    pipeline: names.pipeline,
    documents: names.documents,
    goals: names.goals,
    raid: names.raid,
    governance: names.governance,
    scope: names.scope,
    finance: names.finance,
    analytics: names.analytics,
    settings: names.settings,
  };
  const sheetsOffered = isModuleOffered('sheets');
  return PROJECT_TAB_IDS.filter((id) => id !== 'table' || sheetsOffered).map((id) => ({
    id,
    name: label[id],
    href: `/${id}`,
    icon: TAB_ICONS[id],
  }));
}

/** Is `id` one of the project tabs (and not another project page, like Members)? */
export function isProjectTabId(id: string): id is ProjectTabId {
  return (PROJECT_TAB_IDS as readonly string[]).includes(id);
}

/**
 * Which of the offered tabs the signed-in user may see in this project
 * (project settings › Tabs). Use inside `ProjectPermissionProvider`.
 *
 * `ready` turns true once the answer is final: the project is loaded and, when
 * it hides anything, the caller's project role is known too. Until the role is
 * known the caller counts as a plain member, so a tab may appear late for an
 * admin but never flashes up for someone who may not see it.
 */
export function useProjectTabAccess(projectId: string, offered: readonly ProjectTabId[]) {
  const { settings, isLoading: projectLoading } = useProjectTabSettings(projectId);
  const { role, isAdmin, isLoading: permissionsLoading } = useProjectPermissions();
  const { user } = useUser();
  const hidden = hiddenProjectTabs(settings, { userId: user?.id, role, isAdmin });
  return {
    allowed: offered.filter((id) => !hidden.has(id)),
    hidden,
    ready: !projectLoading && (!hasTabRestrictions(settings) || !permissionsLoading),
  };
}
