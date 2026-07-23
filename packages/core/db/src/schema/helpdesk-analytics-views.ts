import { pgMaterializedView } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { helpdeskTickets } from './helpdesk-tickets';
import { helpdeskConversations } from './helpdesk-conversations';
import { helpdeskSatisfactionSurveys } from './helpdesk-satisfaction-surveys';
import { helpdeskAgents } from './helpdesk-agents';

/**
 * Materialized view for daily ticket aggregations
 * Pre-computes ticket counts and averages grouped by workspace, date, status, priority, and channel
 */
export const mvHelpdeskTicketsDaily = pgMaterializedView('mv_helpdesk_tickets_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${helpdeskTickets.createdAt})`.as('period'),
        status: helpdeskTickets.status,
        priority: helpdeskTickets.priority,
        channel: helpdeskTickets.channel,
        ticketCount: sql<number>`COUNT(*)`.as('ticket_count'),
        escalatedCount: sql<number>`COUNT(*) FILTER (WHERE ${helpdeskTickets.isEscalated} = true)`.as(
          'escalated_count'
        ),
        avgResponseTime:
          sql<string>`AVG(${helpdeskTickets.responseTime}) FILTER (WHERE ${helpdeskTickets.responseTime} IS NOT NULL)`.as(
            'avg_response_time'
          ),
        avgResolutionTime:
          sql<string>`AVG(${helpdeskTickets.resolutionTime}) FILTER (WHERE ${helpdeskTickets.resolutionTime} IS NOT NULL)`.as(
            'avg_resolution_time'
          ),
      })
      .from(helpdeskTickets)
      .where(sql`${helpdeskTickets.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${helpdeskTickets.createdAt})`,
        helpdeskTickets.status,
        helpdeskTickets.priority,
        helpdeskTickets.channel
      )
  );

/**
 * Materialized view for daily conversation aggregations
 * Pre-computes conversation counts and averages grouped by workspace, date, status, and channel
 */
export const mvHelpdeskConversationsDaily = pgMaterializedView('mv_helpdesk_conversations_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${helpdeskConversations.createdAt})`.as('period'),
        status: helpdeskConversations.status,
        channel: helpdeskConversations.channel,
        conversationCount: sql<number>`COUNT(*)`.as('conversation_count'),
        avgMessages: sql<string>`AVG(${helpdeskConversations.messageCount})`.as('avg_messages'),
      })
      .from(helpdeskConversations)
      .where(sql`${helpdeskConversations.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${helpdeskConversations.createdAt})`,
        helpdeskConversations.status,
        helpdeskConversations.channel
      )
  );

/**
 * Materialized view for daily satisfaction survey aggregations
 * Pre-computes survey counts, ratings, and NPS scores grouped by workspace and date
 */
export const mvHelpdeskSatisfactionDaily = pgMaterializedView('mv_helpdesk_satisfaction_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${helpdeskSatisfactionSurveys.sentAt})`.as('period'),
        surveyCount: sql<number>`COUNT(*)`.as('survey_count'),
        completedCount:
          sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.status} = 'completed')`.as(
            'completed_count'
          ),
        avgRating:
          sql<string>`AVG(${helpdeskSatisfactionSurveys.rating}) FILTER (WHERE ${helpdeskSatisfactionSurveys.status} = 'completed')`.as(
            'avg_rating'
          ),
        promoters:
          sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.rating} >= 9)`.as('promoters'),
        detractors:
          sql<number>`COUNT(*) FILTER (WHERE ${helpdeskSatisfactionSurveys.rating} <= 6)`.as('detractors'),
      })
      .from(helpdeskSatisfactionSurveys)
      .where(sql`${helpdeskSatisfactionSurveys.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${helpdeskSatisfactionSurveys.sentAt})`
      )
  );

/**
 * Materialized view for agent performance stats
 * Provides a snapshot of agent metrics without time dimension
 */
export const mvHelpdeskAgentStats = pgMaterializedView('mv_helpdesk_agent_stats')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        agentId: helpdeskAgents.id,
        name: helpdeskAgents.name,
        status: helpdeskAgents.status,
        ticketsResolved: helpdeskAgents.ticketsResolved,
        ticketsAssigned: helpdeskAgents.ticketsAssigned,
        averageResponseTime: helpdeskAgents.averageResponseTime,
        satisfactionScore: helpdeskAgents.satisfactionScore,
      })
      .from(helpdeskAgents)
      .where(sql`${helpdeskAgents.deletedAt} IS NULL`)
  );

// Type exports
export type MvHelpdeskTicketsDaily = typeof mvHelpdeskTicketsDaily.$inferSelect;
export type MvHelpdeskConversationsDaily = typeof mvHelpdeskConversationsDaily.$inferSelect;
export type MvHelpdeskSatisfactionDaily = typeof mvHelpdeskSatisfactionDaily.$inferSelect;
export type MvHelpdeskAgentStats = typeof mvHelpdeskAgentStats.$inferSelect;
