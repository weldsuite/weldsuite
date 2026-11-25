/**
 * What the Backlog page reads: the items, sprints and epics of the project,
 * the open sprints in order and the items laid out in their sections.
 */

import { useMemo } from 'react';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { averageVelocity } from '@/app/weldflow/lib/delivery';
import { BACKLOG_SECTION, buildSections, pickableTypes, type BacklogFilter } from '@/app/weldflow/lib/backlog';
import { useBacklogItems } from '@/hooks/queries/use-flow-agile-backlog-queries';
import { useProjectEpics, useProjectSprints } from '@/hooks/queries/use-flow-agile-queries';

function byStart(a: Sprint, b: Sprint): number {
  return (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999') || a.name.localeCompare(b.name);
}

export function useBacklogData({
  projectId,
  available,
  usesSprints,
  enabledTypes,
  filter,
}: Readonly<{
  projectId: string;
  available: boolean;
  usesSprints: boolean;
  enabledTypes: Parameters<typeof pickableTypes>[0];
  filter: BacklogFilter;
}>) {
  const itemsQuery = useBacklogItems(projectId, available);
  const sprintsQuery = useProjectSprints(projectId, available && usesSprints);
  const epicsQuery = useProjectEpics(projectId, available);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const allSprints = useMemo(() => sprintsQuery.data ?? [], [sprintsQuery.data]);
  const epics = useMemo(() => epicsQuery.data ?? [], [epicsQuery.data]);
  const epicsById = useMemo(() => new Map(epics.map((epic) => [epic.id, epic])), [epics]);

  const activeSprint = allSprints.find((sprint) => sprint.status === 'active');
  const plannedSprints = useMemo(() => allSprints.filter((sprint) => sprint.status === 'planned').sort(byStart), [allSprints]);
  const openSprints = useMemo(() => (activeSprint ? [activeSprint, ...plannedSprints] : plannedSprints), [activeSprint, plannedSprints]);
  const sprintIds = useMemo(() => (usesSprints ? openSprints.map((sprint) => sprint.id) : []), [usesSprints, openSprints]);
  const forecast = useMemo(() => averageVelocity(allSprints), [allSprints]);
  const types = useMemo(() => pickableTypes(enabledTypes), [enabledTypes]);

  const sections = useMemo(() => buildSections(items, sprintIds, filter), [items, sprintIds, filter]);
  const backlogItems = sections[BACKLOG_SECTION] ?? [];

  return {
    itemsQuery,
    epicsQuery,
    items,
    itemsById,
    allSprints,
    epics,
    epicsById,
    activeSprint,
    plannedSprints,
    openSprints,
    forecast,
    types,
    sections,
    backlogItems,
  };
}
