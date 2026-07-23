import { pgMaterializedView } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';
import { tasks } from './tasks';
import { timeEntries } from './time-entries';
import { milestones } from './milestones';

/**
 * Materialized view for daily project aggregations
 * Pre-computes project counts and budget metrics grouped by workspace, date, project, status, and health
 * Includes project_id for per-project analytics filtering
 */
export const mvProjectsSummaryDaily = pgMaterializedView('mv_projects_summary_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${projects.createdAt})`.as('period'),
        projectId: projects.id,
        status: projects.status,
        health: projects.health,
        // Counts
        projectCount: sql<number>`COUNT(*)`.as('project_count'),
        activeCount: sql<number>`COUNT(*) FILTER (WHERE ${projects.isActive} = true)`.as(
          'active_count'
        ),
        // Budget hours
        totalBudgetedHours: sql<string>`SUM(${projects.budgetedHours})`.as('total_budgeted_hours'),
        totalActualHours: sql<string>`SUM(${projects.actualHours})`.as('total_actual_hours'),
        // Budget amount
        totalBudgetedAmount: sql<string>`SUM(${projects.budgetedAmount})`.as(
          'total_budgeted_amount'
        ),
        totalActualAmount: sql<string>`SUM(${projects.actualAmount})`.as('total_actual_amount'),
        // Progress
        avgProgress: sql<string>`AVG(${projects.progress})`.as('avg_progress'),
        // Tasks
        totalTasks: sql<number>`SUM(${projects.totalTasks})`.as('total_tasks'),
        completedTasks: sql<number>`SUM(${projects.completedTasks})`.as('completed_tasks'),
        // Milestones
        totalMilestones: sql<number>`SUM(${projects.totalMilestones})`.as('total_milestones'),
        completedMilestones: sql<number>`SUM(${projects.completedMilestones})`.as(
          'completed_milestones'
        ),
      })
      .from(projects)
      .where(sql`${projects.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${projects.createdAt})`,
        projects.id,
        projects.status,
        projects.health
      )
  );

/**
 * Materialized view for daily task aggregations
 * Pre-computes task counts and time metrics grouped by workspace, date, project, status, priority, and type
 * Includes project_id for per-project analytics filtering
 */
export const mvTasksDaily = pgMaterializedView('mv_tasks_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${tasks.createdAt})`.as('period'),
        projectId: tasks.projectId,
        status: tasks.status,
        priority: tasks.priority,
        type: tasks.type,
        // Counts
        taskCount: sql<number>`COUNT(*)`.as('task_count'),
        completedCount: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'done')`.as(
          'completed_count'
        ),
        overdueCount:
          sql<number>`COUNT(*) FILTER (WHERE ${tasks.dueDate} < NOW() AND ${tasks.status} != 'done' AND ${tasks.status} != 'cancelled')`.as(
            'overdue_count'
          ),
        // Hours
        totalEstimatedHours: sql<string>`SUM(${tasks.estimatedHours})`.as('total_estimated_hours'),
        totalActualHours: sql<string>`SUM(${tasks.actualHours})`.as('total_actual_hours'),
        // Progress
        avgProgress: sql<string>`AVG(${tasks.progress})`.as('avg_progress'),
      })
      .from(tasks)
      .where(sql`${tasks.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${tasks.createdAt})`,
        tasks.projectId,
        tasks.status,
        tasks.priority,
        tasks.type
      )
  );

/**
 * Materialized view for daily time entry aggregations
 * Pre-computes duration and billing metrics grouped by workspace, date, project, user, and status
 * Includes project_id for per-project analytics filtering
 */
export const mvTimeEntriesDaily = pgMaterializedView('mv_time_entries_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${timeEntries.date}::timestamp)`.as('period'),
        projectId: timeEntries.projectId,
        userId: timeEntries.userId,
        status: timeEntries.status,
        // Counts
        entryCount: sql<number>`COUNT(*)`.as('entry_count'),
        // Duration (in minutes)
        totalDuration: sql<string>`SUM(${timeEntries.duration})`.as('total_duration'),
        billableDuration:
          sql<string>`SUM(${timeEntries.duration}) FILTER (WHERE ${timeEntries.billable} = true)`.as(
            'billable_duration'
          ),
        nonBillableDuration:
          sql<string>`SUM(${timeEntries.duration}) FILTER (WHERE ${timeEntries.billable} = false)`.as(
            'non_billable_duration'
          ),
        // Cost
        totalCost: sql<string>`SUM(${timeEntries.cost})`.as('total_cost'),
        avgRate:
          sql<string>`AVG(${timeEntries.rate}) FILTER (WHERE ${timeEntries.rate} IS NOT NULL)`.as(
            'avg_rate'
          ),
      })
      .from(timeEntries)
      .where(sql`${timeEntries.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${timeEntries.date}::timestamp)`,
        timeEntries.projectId,
        timeEntries.userId,
        timeEntries.status
      )
  );

/**
 * Materialized view for milestone statistics
 * Non-temporal view providing current milestone status and progress
 * Includes project_id for per-project analytics filtering
 */
export const mvMilestoneStats = pgMaterializedView('mv_milestone_stats')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        projectId: milestones.projectId,
        milestoneId: milestones.id,
        name: milestones.name,
        status: milestones.status,
        dueDate: milestones.dueDate,
        completedAt: milestones.completedAt,
        // Progress
        progress: milestones.progress,
        completedTasks: milestones.completedTasks,
        totalTasks: milestones.totalTasks,
        // Derived flags
        isOverdue:
          sql<boolean>`CASE WHEN ${milestones.dueDate} < NOW() AND ${milestones.status} != 'completed' THEN true ELSE false END`.as(
            'is_overdue'
          ),
        isOnTime:
          sql<boolean>`CASE WHEN ${milestones.completedAt} IS NOT NULL AND ${milestones.completedAt} <= ${milestones.dueDate} THEN true ELSE false END`.as(
            'is_on_time'
          ),
        isKeyMilestone: milestones.isKeyMilestone,
      })
      .from(milestones)
      .where(sql`${milestones.deletedAt} IS NULL`)
  );

// Type exports
export type MvProjectsSummaryDaily = typeof mvProjectsSummaryDaily.$inferSelect;
export type MvTasksDaily = typeof mvTasksDaily.$inferSelect;
export type MvTimeEntriesDaily = typeof mvTimeEntriesDaily.$inferSelect;
export type MvMilestoneStats = typeof mvMilestoneStats.$inferSelect;
