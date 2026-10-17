/**
 * Row filters shared by the task list routes.
 */

import { sql, type Column, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';

/**
 * A task that is not inside a soft-deleted project: personal / CRM tasks (no
 * project) stay, project tasks stay while their project is live. Applies on the
 * `scope:all` path too, where the access check alone does not narrow by project.
 */
export function taskInLiveProject(projectIdColumn: Column): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${schema.projects} WHERE ${schema.projects.id} = ${projectIdColumn} AND ${schema.projects.deletedAt} IS NOT NULL)`;
}
