
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useAppApi } from '@/lib/api/use-app-api';
import { boardsQueryKey } from '@/app/weldboard/store/use-board-store';
import { useProject } from '@/hooks/queries/use-projects-queries';
import { useI18n } from '@/lib/i18n/provider';

interface ProjectsHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function ProjectsHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: Readonly<ProjectsHeaderProps>) {
  const { t } = useI18n();
  const pathname = usePathname();

  // Extract project ID from path: /weldflow/project/{projectId}/...
  const pathParts = pathname.split('/').filter(Boolean);
  const projectIndex = pathParts.indexOf('project');
  const projectId = projectIndex >= 0 ? pathParts[projectIndex + 1] : undefined;

  // Extract whiteboard ID: /weldflow/project/{projectId}/whiteboard/{whiteboardId}
  const whiteboardIndex = pathParts.indexOf('whiteboard');
  const whiteboardId = whiteboardIndex >= 0 ? pathParts[whiteboardIndex + 1] : undefined;

  // Fetch project name (cached by TanStack Query, no extra request if already loaded)
  const { data: projectData } = useProject(projectId || '', !!projectId);
  const projectName = projectData?.data?.name;

  // The whiteboard's name (a WeldBoard board in board-api)
  const appApi = useAppApi();
  const { data: whiteboardData } = useQuery({
    queryKey: [...boardsQueryKey, 'name', whiteboardId],
    queryFn: () => appApi.boards.get(whiteboardId!),
    enabled: !!projectId && !!whiteboardId,
  });
  const whiteboardName = whiteboardData?.data?.name;

  const segments: BreadcrumbSegment[] = useMemo(() => {
    const routeLabels: Record<string, string> = {
      'all-projects': t.projects.projectLayout.routeLabels.allProjects,
      'tasks': t.projects.projectLayout.routeLabels.tasks,
      'whiteboard': t.projects.projectLayout.routeLabels.whiteboard,
      'members': t.projects.projectLayout.routeLabels.members,
      'messages': t.projects.projectLayout.routeLabels.messages,
      'files': t.projects.projectLayout.routeLabels.files,
      'goals': t.projects.projectLayout.routeLabels.goals,
      'raid': t.projects.projectLayout.routeLabels.raid,
      'assumptions': t.projects.projectLayout.routeLabels.assumptions,
      'issues': t.projects.projectLayout.routeLabels.issues,
      'dependencies': t.projects.projectLayout.routeLabels.dependencies,
      'analytics': t.projects.projectLayout.routeLabels.analytics,
      'workload': t.projects.projectLayout.routeLabels.workload,
      'settings': t.projects.projectLayout.routeLabels.settings,
      'sprints': t.projects.projectLayout.routeLabels.sprints,
      'governance': t.projects.projectLayout.routeLabels.governance,
      'decisions': t.projects.projectLayout.routeLabels.decisions,
      'changes': t.projects.projectLayout.routeLabels.changes,
      'stakeholders': t.projects.projectLayout.routeLabels.stakeholders,
      'scope': t.projects.projectLayout.routeLabels.scope,
      'value': t.projects.projectLayout.routeLabels.value,
      'finance': t.projects.projectLayout.routeLabels.finance,
      'costs': t.projects.projectLayout.routeLabels.costs,
      'forecast': t.projects.projectLayout.routeLabels.forecast,
      'phases': t.projects.projectLayout.routeLabels.phases,
      'close': t.projects.projectLayout.routeLabels.close,
      'reviews': t.projects.projectLayout.routeLabels.reviews,
      'templates': t.projects.projectLayout.routeLabels.templates,
      'capacity': t.projects.projectLayout.routeLabels.capacity,
      'intake': t.projects.projectLayout.routeLabels.intake,
      'roadmap': t.projects.projectLayout.routeLabels.roadmap,
    };

    const result: BreadcrumbSegment[] = [
      { label: t.projects.title, href: '/weldflow' }
    ];

    // /weldflow index page is the My Tasks view — show it as a leaf segment.
    if (pathParts.length === 1) {
      result.push({ label: t.projects.myTasks.title });
      return result;
    }

    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const href = '/' + pathParts.slice(0, i + 1).join('/');

      // Skip the "project" namespace segment
      if (part === 'project') continue;

      // Known route labels
      if (routeLabels[part]) {
        result.push({ label: routeLabels[part], href });
        continue;
      }

      // Resolve project ID to name
      if (part === projectId) {
        result.push({ label: projectName || '...', href });
        continue;
      }

      // Resolve whiteboard ID to name
      if (part === whiteboardId) {
        result.push({ label: whiteboardName || '...', href });
        continue;
      }

      // Other segments (other IDs, unknown routes) — capitalize
      const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      result.push({ label, href });
    }

    return result;
  }, [pathParts, projectId, projectName, whiteboardId, whiteboardName, t]);

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton={true}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="projects"
    />
  );
}
