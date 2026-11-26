/**
 * Projects made from the task dialog's "Create project" on My tasks: kept next
 * to the fetched list until it refetches, and shown in the dialog's picker as
 * the same coloured square the sidebar and the project list draw.
 */

import { FolderKanban } from 'lucide-react';
import { coloredSquareColors, findColoredSquareIconByLabel } from '@/components/app-sidebar-layout';

export interface ProjectInfo {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

/** The fetched projects, then the ones made here that the list does not have yet. */
export function withCreatedProjects<T extends { id: string }>(projects: readonly T[], created: readonly T[]): T[] {
  return [...projects, ...created.filter((c) => !projects.some((p) => p.id === c.id))];
}

/** A project as the task dialog's picker shows it. */
export function projectPickerOption(project: ProjectInfo) {
  return {
    id: project.id,
    name: project.name,
    icon: (project.icon ? findColoredSquareIconByLabel(project.icon) : undefined) || FolderKanban,
    iconColor: project.color || coloredSquareColors[0].value,
  };
}

/** The project a create call made, or null when it failed. */
export function createdProject(
  result: { success: boolean; data?: { id: string; name?: string | null; color?: string | null; icon?: string | null } | null },
  name: string,
): ProjectInfo | null {
  if (!result.success || !result.data) return null;
  return { id: result.data.id, name: result.data.name || name, color: result.data.color ?? null, icon: result.data.icon ?? null };
}
