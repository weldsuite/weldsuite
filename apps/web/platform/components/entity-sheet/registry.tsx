import { TicketSheet } from './renderers/ticket-sheet';
import { InvoiceSheet } from './renderers/invoice-sheet';
import { BillSheet } from './renderers/bill-sheet';
import { DomainSheet } from './renderers/domain-sheet';
import { TaskSheet } from './renderers/task-sheet';
import { LeadSheet } from './renderers/lead-sheet';
import { OpportunitySheet } from './renderers/opportunity-sheet';
import { ProjectSheet } from './renderers/project-sheet';
import { ArticleSheet } from './renderers/article-sheet';
import type { EntitySheetRegistry } from './types';
import type { EntitySheetRendererType } from './registry-meta';

// hasEntitySheetRenderer / pageHrefForEntity live in registry-meta.ts so that
// metadata-only consumers (e.g. chat mention chips) don't import the renderer
// tree — that edge created an import cycle back through the entity panels.
export { hasEntitySheetRenderer, pageHrefForEntity } from './registry-meta';

export const DEFAULT_ENTITY_SHEET_REGISTRY = {
  ticket: TicketSheet,
  invoice: InvoiceSheet,
  bill: BillSheet,
  domain: DomainSheet,
  task: TaskSheet,
  lead: LeadSheet,
  opportunity: OpportunitySheet,
  project: ProjectSheet,
  article: ArticleSheet,
} satisfies Record<EntitySheetRendererType, EntitySheetRegistry[keyof EntitySheetRegistry]> as EntitySheetRegistry;
