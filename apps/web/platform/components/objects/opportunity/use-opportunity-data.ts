/**
 * Colocated data hooks for the opportunity object panel.
 *
 * Currently re-exports from `hooks/queries/use-opportunities-queries.ts`
 * (which still targets the legacy api-worker `/crm/opportunities/*` routes).
 * When those routes are migrated to `apps/workers/app-api`, the read/write
 * implementations should move here directly — same shape as
 * `objects/company/use-company-data.ts`.
 */

export {
  
  useOpportunity,
  useOpportunityActivities,
  useUpdateOpportunity,
  useDeleteOpportunity,
  useWinOpportunity,
  useLoseOpportunity,
  
  type Opportunity,
  
} from '@/hooks/queries/use-opportunities-queries';
