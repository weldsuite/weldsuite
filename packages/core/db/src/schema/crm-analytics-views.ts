import { pgMaterializedView } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { crmLeads } from './crm-leads';
import { crmOpportunities } from './crm-opportunities';
import { crmActivities } from './crm-activities';

/**
 * Materialized view for daily lead aggregations
 * Pre-computes lead counts and averages grouped by workspace, date, status, source, and rating
 */
export const mvCrmLeadsDaily = pgMaterializedView('mv_crm_leads_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${crmLeads.createdAt})`.as('period'),
        status: crmLeads.status,
        source: crmLeads.source,
        rating: crmLeads.rating,
        // Counts
        leadCount: sql<number>`COUNT(*)`.as('lead_count'),
        qualifiedCount: sql<number>`COUNT(*) FILTER (WHERE ${crmLeads.isQualified} = true)`.as(
          'qualified_count'
        ),
        convertedCount: sql<number>`COUNT(*) FILTER (WHERE ${crmLeads.convertedAt} IS NOT NULL)`.as(
          'converted_count'
        ),
        // Averages
        avgScore: sql<string>`AVG(${crmLeads.score})`.as('avg_score'),
        // Time metrics (in hours)
        avgTimeToConvert:
          sql<string>`AVG(EXTRACT(EPOCH FROM (${crmLeads.convertedAt} - ${crmLeads.createdAt})) / 3600) FILTER (WHERE ${crmLeads.convertedAt} IS NOT NULL)`.as(
            'avg_time_to_convert'
          ),
        avgTimeToQualify:
          sql<string>`AVG(EXTRACT(EPOCH FROM (${crmLeads.qualifiedAt} - ${crmLeads.createdAt})) / 3600) FILTER (WHERE ${crmLeads.qualifiedAt} IS NOT NULL)`.as(
            'avg_time_to_qualify'
          ),
        avgTimeToFirstResponse:
          sql<string>`AVG(EXTRACT(EPOCH FROM (${crmLeads.firstResponseAt} - ${crmLeads.createdAt})) / 3600) FILTER (WHERE ${crmLeads.firstResponseAt} IS NOT NULL)`.as(
            'avg_time_to_first_response'
          ),
      })
      .from(crmLeads)
      .where(sql`${crmLeads.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${crmLeads.createdAt})`,
        crmLeads.status,
        crmLeads.source,
        crmLeads.rating
      )
  );

/**
 * Materialized view for daily opportunity aggregations
 * Pre-computes opportunity counts, amounts, and win rates grouped by workspace, date, stage, status, forecast, and risk
 */
export const mvCrmOpportunitiesDaily = pgMaterializedView('mv_crm_opportunities_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${crmOpportunities.createdAt})`.as('period'),
        stage: crmOpportunities.stage,
        status: crmOpportunities.status,
        forecastCategory: crmOpportunities.forecastCategory,
        riskLevel: crmOpportunities.riskLevel,
        // Counts
        opportunityCount: sql<number>`COUNT(*)`.as('opportunity_count'),
        wonCount: sql<number>`COUNT(*) FILTER (WHERE ${crmOpportunities.status} = 'won')`.as(
          'won_count'
        ),
        lostCount: sql<number>`COUNT(*) FILTER (WHERE ${crmOpportunities.status} = 'lost')`.as(
          'lost_count'
        ),
        // Amounts
        totalAmount: sql<string>`SUM(${crmOpportunities.amount})`.as('total_amount'),
        avgAmount: sql<string>`AVG(${crmOpportunities.amount})`.as('avg_amount'),
        weightedAmount:
          sql<string>`SUM(${crmOpportunities.amount} * ${crmOpportunities.probability} / 100)`.as(
            'weighted_amount'
          ),
        wonAmount:
          sql<string>`SUM(${crmOpportunities.amount}) FILTER (WHERE ${crmOpportunities.status} = 'won')`.as(
            'won_amount'
          ),
        lostAmount:
          sql<string>`SUM(${crmOpportunities.amount}) FILTER (WHERE ${crmOpportunities.status} = 'lost')`.as(
            'lost_amount'
          ),
        // Averages
        avgProbability: sql<string>`AVG(${crmOpportunities.probability})`.as('avg_probability'),
        avgDaysInStage: sql<string>`AVG(${crmOpportunities.daysInCurrentStage})`.as(
          'avg_days_in_stage'
        ),
      })
      .from(crmOpportunities)
      .where(sql`${crmOpportunities.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${crmOpportunities.createdAt})`,
        crmOpportunities.stage,
        crmOpportunities.status,
        crmOpportunities.forecastCategory,
        crmOpportunities.riskLevel
      )
  );

/**
 * Materialized view for daily activity aggregations
 * Pre-computes activity counts and durations grouped by workspace, date, type, status, related entity, and call direction
 */
export const mvCrmActivitiesDaily = pgMaterializedView('mv_crm_activities_daily')
  .withNoData()
  .as((qb) =>
    qb
      .select({
        period: sql<Date>`DATE_TRUNC('day', ${crmActivities.createdAt})`.as('period'),
        type: crmActivities.type,
        status: crmActivities.status,
        relatedTo: crmActivities.relatedTo,
        callDirection: crmActivities.callDirection,
        // Counts
        activityCount: sql<number>`COUNT(*)`.as('activity_count'),
        completedCount:
          sql<number>`COUNT(*) FILTER (WHERE ${crmActivities.status} = 'completed')`.as(
            'completed_count'
          ),
        // Duration metrics (in minutes)
        avgDuration:
          sql<string>`AVG(${crmActivities.duration}) FILTER (WHERE ${crmActivities.duration} IS NOT NULL)`.as(
            'avg_duration'
          ),
        totalDuration:
          sql<string>`SUM(${crmActivities.duration}) FILTER (WHERE ${crmActivities.duration} IS NOT NULL)`.as(
            'total_duration'
          ),
        // Call-specific metrics (in seconds, converted to minutes in queries)
        avgCallDuration:
          sql<string>`AVG(${crmActivities.callDuration}) FILTER (WHERE ${crmActivities.callDuration} IS NOT NULL)`.as(
            'avg_call_duration'
          ),
        totalCallDuration:
          sql<string>`SUM(${crmActivities.callDuration}) FILTER (WHERE ${crmActivities.callDuration} IS NOT NULL)`.as(
            'total_call_duration'
          ),
        // Call direction counts
        inboundCalls:
          sql<number>`COUNT(*) FILTER (WHERE ${crmActivities.callDirection} = 'inbound')`.as(
            'inbound_calls'
          ),
        outboundCalls:
          sql<number>`COUNT(*) FILTER (WHERE ${crmActivities.callDirection} = 'outbound')`.as(
            'outbound_calls'
          ),
      })
      .from(crmActivities)
      .where(sql`${crmActivities.deletedAt} IS NULL`)
      .groupBy(
        sql`DATE_TRUNC('day', ${crmActivities.createdAt})`,
        crmActivities.type,
        crmActivities.status,
        crmActivities.relatedTo,
        crmActivities.callDirection
      )
  );

// Type exports
export type MvCrmLeadsDaily = typeof mvCrmLeadsDaily.$inferSelect;
export type MvCrmOpportunitiesDaily = typeof mvCrmOpportunitiesDaily.$inferSelect;
export type MvCrmActivitiesDaily = typeof mvCrmActivitiesDaily.$inferSelect;
