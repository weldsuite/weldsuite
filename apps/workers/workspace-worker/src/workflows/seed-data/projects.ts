/**
 * Projects sample data seeder.
 *
 * Seeds: one getting-started project with 4 tasks.
 */

import { projects } from '@weldsuite/db/schema/projects';
import { tasks } from '@weldsuite/db/schema/tasks';
import type { DrizzleDb, SeedContext } from './types';

export async function seedProjectsData(db: DrizzleDb, ctx: SeedContext): Promise<void> {
  // Idempotency: skip if projects already exist
  const existing = await db.select({ id: projects.id }).from(projects).limit(1);
  if (existing.length > 0) {
    console.log('[Seed:Projects] Projects already exist, skipping');
    return;
  }

  const now = new Date();
  const { generateId, userId } = ctx;

  // ── Project ────────────────────────────────────────────────────────────
  const projectId = generateId('prj');

  await db.insert(projects).values({
    id: projectId,
    name: 'Getting Started with WeldSuite',
    description: 'Your onboarding checklist to get the most out of WeldSuite. Complete these tasks to set up your workspace.',
    key: 'GS',
    status: 'In Progress',
    priority: 'high',
    type: 'onboarding',
    progress: '25',
    totalTasks: 4,
    completedTasks: 1,
    openTasks: 3,
    leaderId: userId,
    isBillable: false,
    isActive: true,
    trackTime: false,
    methodology: 'kanban',
    color: '#3B82F6',
    // projects table has NO defaultNow() — must set explicitly
    createdAt: now,
    updatedAt: now,
  });

  // ── Tasks ──────────────────────────────────────────────────────────────
  await db.insert(tasks).values([
    {
      id: generateId('tsk'),
      projectId,
      title: 'Set up your workspace',
      description: 'Configure your workspace name, timezone, and basic settings. This is done automatically during onboarding.',
      key: 'GS-1',
      status: 'done',
      priority: 'high',
      type: 'task',
      position: 0,
      assigneeId: userId,
      reporterId: userId,
      completedDate: now,
      progress: '100',
    },
    {
      id: generateId('tsk'),
      projectId,
      title: 'Invite your team members',
      description: 'Go to Settings > Members to invite colleagues to your workspace. They will receive an email invitation to join.',
      key: 'GS-2',
      status: 'todo',
      priority: 'high',
      type: 'task',
      position: 1,
      assigneeId: userId,
      reporterId: userId,
    },
    {
      id: generateId('tsk'),
      projectId,
      title: 'Configure integrations',
      description: 'Connect your email, calendar, and other tools in Settings > Integrations to get the most out of WeldSuite.',
      key: 'GS-3',
      status: 'todo',
      priority: 'medium',
      type: 'task',
      position: 2,
      assigneeId: userId,
      reporterId: userId,
    },
    {
      id: generateId('tsk'),
      projectId,
      title: 'Create your first project',
      description: 'Once your team is on board, create a real project to start collaborating. Use this project as a reference for how tasks and boards work.',
      key: 'GS-4',
      status: 'todo',
      priority: 'low',
      type: 'task',
      position: 3,
      assigneeId: userId,
      reporterId: userId,
    },
  ]);

  console.log('[Seed:Projects] Seeded 1 project with 4 tasks');
}
