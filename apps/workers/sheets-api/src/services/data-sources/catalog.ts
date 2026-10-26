/**
 * Connected tables — where each object's records live, and who sees which.
 *
 * `SHEET_DATA_OBJECTS` (@weldsuite/app-api-client/schemas/sheet-data) says
 * which fields an object offers; this registry maps every one of those keys to
 * a column of the object's tenant table. The `columns` map is typed against
 * the shared field keys AND against the table, so a field without a column, a
 * column for a field that does not exist, or a renamed column all fail `tsc`.
 *
 * Record-level visibility mirrors the module's own list route, so a sheet
 * never shows a record its viewer could not open in the module:
 *   - companies, people, leads, opportunities: only rows the viewer owns
 *     (`ownerId`) unless they hold `<object>:scope:all` (crm-api scopeFor).
 *   - people: only people in the CRM (`inCrm`), never mail-only identities,
 *     like the WeldCRM People table.
 *   - projects: only projects the viewer manages or is an active member of,
 *     unless they hold `projects:scope:all` (flow-api GET /projects).
 *   - tasks: personal tasks plus tasks of those projects, never tasks of a
 *     deleted project (flow-api GET /tasks).
 * Quotes, tickets, products, orders and invoices have no rule beyond the read
 * permission in their modules.
 */

import { eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { schema } from '@weldsuite/worker-kit/db';
import type { SheetDataFieldKey, SheetDataObjectKey } from '@weldsuite/app-api-client/schemas/sheet-data';

/** What every listable table has: an id, a creation time and maybe a soft-delete stamp. */
type DataTable = PgTable & {
  id: AnyPgColumn;
  createdAt: AnyPgColumn;
  deletedAt?: AnyPgColumn;
};

/** Who a listing is for. */
export interface DataViewer {
  userId: string;
  /**
   * Whether the viewer holds a workspace permission, denies and app scoping
   * applied: `(key) => hasContextPermission(c, key)` in a route, or the
   * connecting member's resolved permissions for a scheduled refresh.
   */
  hasPermission: (permission: string) => boolean | Promise<boolean>;
}

interface DataSourceDefinition<K extends SheetDataObjectKey, T extends DataTable> {
  table: T;
  /** One column per field key of the object, no more and no less. */
  columns: { readonly [F in SheetDataFieldKey<K>]: (t: T) => AnyPgColumn };
  /** Whether rows soft-delete (`deletedAt`); deleted rows are never listed. */
  softDeletes: boolean;
  /** Rows no listing shows, whoever asks (e.g. mail-only people). */
  baseWhere?: (t: T) => SQL;
  /**
   * Record-level visibility: without `allPermission`, a viewer only sees the
   * rows `where` matches for them.
   */
  scope?: { allPermission: string; where: (t: T, userId: string) => SQL };
}

/** A registry entry with its table type erased (see `defineSource`). */
export interface DataSource {
  table: DataTable;
  columns: Readonly<Record<string, (t: DataTable) => AnyPgColumn>>;
  softDeletes: boolean;
  baseWhere?: (t: DataTable) => SQL;
  scope?: { allPermission: string; where: (t: DataTable, userId: string) => SQL };
}

/**
 * Registry entry factory. Exists so each entry's accessors are checked against
 * ITS OWN table and ITS OWN field keys (as `defineTarget` does in app-api's
 * custom-object-targets); the cast on the way out only erases those types for
 * the generic query code.
 */
function defineSource<K extends SheetDataObjectKey, T extends DataTable>(
  _key: K,
  def: DataSourceDefinition<K, T>,
): DataSource {
  return def as unknown as DataSource;
}

/** Rows owned by the viewer (the CRM's own-records rule). */
const ownedBy = (ownerId: AnyPgColumn, userId: string): SQL => eq(ownerId, userId);

const { projects, projectMembers } = schema;

/** The project in `projectId` is one the viewer manages or is an active member of. */
function memberOfProject(projectId: AnyPgColumn | SQL, userId: string): SQL {
  return sql`exists (select 1 from ${projectMembers} where ${projectMembers.projectId} = ${projectId} and ${projectMembers.userId} = ${userId} and ${projectMembers.isActive} = true and ${projectMembers.deletedAt} is null)`;
}

export const DATA_SOURCES: Readonly<Record<SheetDataObjectKey, DataSource>> = {
  companies: defineSource('companies', {
    table: schema.companies,
    softDeletes: true,
    scope: { allPermission: 'companies:scope:all', where: (t, userId) => ownedBy(t.ownerId, userId) },
    columns: {
      // The canonical, server-stamped name every grid and export shows.
      name: (t) => t.displayName,
      tradingName: (t) => t.tradingName,
      email: (t) => t.email,
      phone: (t) => t.phone,
      website: (t) => t.website,
      industry: (t) => t.industry,
      status: (t) => t.status,
      lifecycleStage: (t) => t.lifecycleStage,
      source: (t) => t.source,
      employeeCount: (t) => t.employeeCount,
      vatNumber: (t) => t.vatNumber,
      ownerId: (t) => t.ownerId,
      accountManagerId: (t) => t.accountManagerId,
      isSupplier: (t) => t.isSupplier,
      leadScore: (t) => t.leadScore,
      lastContactDate: (t) => t.lastContactDate,
      nextFollowUpDate: (t) => t.nextFollowUpDate,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
      archivedAt: (t) => t.archivedAt,
    },
  }),
  people: defineSource('people', {
    table: schema.people,
    softDeletes: true,
    baseWhere: (t) => eq(t.inCrm, true),
    scope: { allPermission: 'people:scope:all', where: (t, userId) => ownedBy(t.ownerId, userId) },
    columns: {
      name: (t) => t.displayName,
      firstName: (t) => t.firstName,
      lastName: (t) => t.lastName,
      email: (t) => t.email,
      directPhone: (t) => t.directPhone,
      mobilePhone: (t) => t.mobilePhone,
      title: (t) => t.title,
      department: (t) => t.department,
      status: (t) => t.status,
      lifecycleStage: (t) => t.lifecycleStage,
      source: (t) => t.source,
      ownerId: (t) => t.ownerId,
      accountManagerId: (t) => t.accountManagerId,
      isDecisionMaker: (t) => t.isDecisionMaker,
      leadScore: (t) => t.leadScore,
      lastContactedAt: (t) => t.lastContactedAt,
      nextFollowUpDate: (t) => t.nextFollowUpDate,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
      archivedAt: (t) => t.archivedAt,
    },
  }),
  leads: defineSource('leads', {
    table: schema.crmLeads,
    softDeletes: true,
    scope: { allPermission: 'leads:scope:all', where: (t, userId) => ownedBy(t.ownerId, userId) },
    columns: {
      name: (t) => t.fullName,
      firstName: (t) => t.firstName,
      lastName: (t) => t.lastName,
      companyName: (t) => t.companyName,
      title: (t) => t.title,
      email: (t) => t.email,
      phone: (t) => t.phone,
      source: (t) => t.source,
      status: (t) => t.status,
      rating: (t) => t.rating,
      score: (t) => t.score,
      ownerId: (t) => t.ownerId,
      isQualified: (t) => t.isQualified,
      convertedAt: (t) => t.convertedAt,
      lastActivityAt: (t) => t.lastActivityAt,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  opportunities: defineSource('opportunities', {
    table: schema.crmOpportunities,
    softDeletes: true,
    scope: { allPermission: 'opportunities:scope:all', where: (t, userId) => ownedBy(t.ownerId, userId) },
    columns: {
      name: (t) => t.name,
      customerName: (t) => t.customerName,
      amount: (t) => t.amount,
      currency: (t) => t.currency,
      expectedRevenue: (t) => t.expectedRevenue,
      stage: (t) => t.stage,
      probability: (t) => t.probability,
      status: (t) => t.status,
      pipeline: (t) => t.pipeline,
      type: (t) => t.type,
      forecastCategory: (t) => t.forecastCategory,
      leadSource: (t) => t.leadSource,
      ownerId: (t) => t.ownerId,
      closeDate: (t) => t.closeDate,
      actualCloseDate: (t) => t.actualCloseDate,
      nextStep: (t) => t.nextStep,
      nextStepDate: (t) => t.nextStepDate,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  quotes: defineSource('quotes', {
    table: schema.crmQuotes,
    softDeletes: true,
    columns: {
      quoteNumber: (t) => t.quoteNumber,
      name: (t) => t.name,
      status: (t) => t.status,
      subtotal: (t) => t.subtotal,
      discount: (t) => t.discount,
      tax: (t) => t.tax,
      shipping: (t) => t.shipping,
      total: (t) => t.total,
      currency: (t) => t.currency,
      validFrom: (t) => t.validFrom,
      validUntil: (t) => t.validUntil,
      opportunityId: (t) => t.opportunityId,
      sentAt: (t) => t.sentAt,
      approvedAt: (t) => t.approvedAt,
      signedAt: (t) => t.signedAt,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  tickets: defineSource('tickets', {
    table: schema.helpdeskTickets,
    softDeletes: true,
    columns: {
      ticketNumber: (t) => t.ticketNumber,
      subject: (t) => t.subject,
      status: (t) => t.status,
      priority: (t) => t.priority,
      category: (t) => t.category,
      channel: (t) => t.channel,
      customerName: (t) => t.customerName,
      customerEmail: (t) => t.customerEmail,
      customerCompany: (t) => t.customerCompany,
      assigneeId: (t) => t.assigneeId,
      assigneeName: (t) => t.assigneeName,
      slaStatus: (t) => t.slaStatus,
      firstResponseAt: (t) => t.firstResponseAt,
      resolvedAt: (t) => t.resolvedAt,
      closedAt: (t) => t.closedAt,
      satisfactionRating: (t) => t.satisfactionRating,
      messageCount: (t) => t.messageCount,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  projects: defineSource('projects', {
    table: schema.projects,
    softDeletes: true,
    scope: {
      allPermission: 'projects:scope:all',
      where: (t, userId) => or(eq(t.projectManagerId, userId), memberOfProject(t.id, userId))!,
    },
    columns: {
      name: (t) => t.name,
      code: (t) => t.code,
      status: (t) => t.status,
      priority: (t) => t.priority,
      health: (t) => t.health,
      type: (t) => t.type,
      progress: (t) => t.progress,
      projectManagerId: (t) => t.projectManagerId,
      startDate: (t) => t.startDate,
      endDate: (t) => t.endDate,
      budgetedAmount: (t) => t.budgetedAmount,
      actualAmount: (t) => t.actualAmount,
      budgetedHours: (t) => t.budgetedHours,
      actualHours: (t) => t.actualHours,
      isBillable: (t) => t.isBillable,
      totalTasks: (t) => t.totalTasks,
      completedTasks: (t) => t.completedTasks,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  tasks: defineSource('tasks', {
    table: schema.tasks,
    softDeletes: true,
    // A task of a deleted project goes with it, for scope:all holders too.
    baseWhere: (t) =>
      sql`not exists (select 1 from ${projects} where ${projects.id} = ${t.projectId} and ${projects.deletedAt} is not null)`,
    scope: {
      allPermission: 'projects:scope:all',
      where: (t, userId) =>
        or(
          isNull(t.projectId),
          sql`exists (select 1 from ${projects} where ${projects.id} = ${t.projectId} and ${projects.deletedAt} is null and (${projects.projectManagerId} = ${userId} or ${memberOfProject(projects.id, userId)}))`,
        )!,
    },
    columns: {
      title: (t) => t.title,
      key: (t) => t.key,
      status: (t) => t.status,
      priority: (t) => t.priority,
      type: (t) => t.type,
      category: (t) => t.category,
      projectId: (t) => t.projectId,
      assigneeId: (t) => t.assigneeId,
      reporterId: (t) => t.reporterId,
      startDate: (t) => t.startDate,
      dueDate: (t) => t.dueDate,
      completedDate: (t) => t.completedDate,
      estimatedHours: (t) => t.estimatedHours,
      actualHours: (t) => t.actualHours,
      storyPoints: (t) => t.storyPoints,
      progress: (t) => t.progress,
      isBillable: (t) => t.isBillable,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  products: defineSource('products', {
    table: schema.products,
    softDeletes: true,
    columns: {
      name: (t) => t.name,
      sku: (t) => t.sku,
      barcode: (t) => t.barcode,
      status: (t) => t.status,
      price: (t) => t.price,
      compareAtPrice: (t) => t.compareAtPrice,
      costPrice: (t) => t.costPrice,
      currency: (t) => t.currency,
      inventoryQuantity: (t) => t.inventoryQuantity,
      lowStockThreshold: (t) => t.lowStockThreshold,
      productType: (t) => t.productType,
      vendor: (t) => t.vendor,
      brand: (t) => t.brand,
      visibility: (t) => t.visibility,
      salesCount: (t) => t.salesCount,
      publishedAt: (t) => t.publishedAt,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  orders: defineSource('orders', {
    table: schema.orders,
    softDeletes: true,
    columns: {
      orderNumber: (t) => t.orderNumber,
      status: (t) => t.status,
      paymentStatus: (t) => t.paymentStatus,
      fulfillmentStatus: (t) => t.fulfillmentStatus,
      customerName: (t) => t.customerName,
      customerEmail: (t) => t.customerEmail,
      currency: (t) => t.currency,
      subtotal: (t) => t.subtotal,
      discountTotal: (t) => t.discountTotal,
      shippingTotal: (t) => t.shippingTotal,
      taxTotal: (t) => t.taxTotal,
      total: (t) => t.total,
      itemCount: (t) => t.itemCount,
      source: (t) => t.source,
      paidAt: (t) => t.paidAt,
      shippedAt: (t) => t.shippedAt,
      deliveredAt: (t) => t.deliveredAt,
      cancelledAt: (t) => t.cancelledAt,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
  invoices: defineSource('invoices', {
    table: schema.invoices,
    softDeletes: true,
    columns: {
      invoiceNumber: (t) => t.invoiceNumber,
      type: (t) => t.type,
      status: (t) => t.status,
      contactName: (t) => t.contactName,
      contactEmail: (t) => t.contactEmail,
      issueDate: (t) => t.issueDate,
      dueDate: (t) => t.dueDate,
      paidAt: (t) => t.paidAt,
      sentAt: (t) => t.sentAt,
      currency: (t) => t.currency,
      subtotal: (t) => t.subtotal,
      discountTotal: (t) => t.discountTotal,
      taxTotal: (t) => t.taxTotal,
      total: (t) => t.total,
      amountPaid: (t) => t.amountPaid,
      balanceDue: (t) => t.balanceDue,
      reference: (t) => t.reference,
      entityId: (t) => t.entityId,
      createdAt: (t) => t.createdAt,
      updatedAt: (t) => t.updatedAt,
    },
  }),
};

/**
 * The conditions every listing of a source for `viewer` carries: live rows
 * only, the object's fixed narrowing, and the viewer's record-level scope.
 */
export async function visibilityConditions(source: DataSource, viewer: DataViewer): Promise<SQL[]> {
  const { table } = source;
  const conditions: SQL[] = [];
  if (source.softDeletes) {
    // Throw rather than skip: a registry entry that claims soft deletes on a
    // table without `deletedAt` would otherwise list deleted records silently.
    if (!table.deletedAt) throw new Error('[sheets-api/data-sources] softDeletes declared on a table without deletedAt');
    conditions.push(isNull(table.deletedAt));
  }
  if (source.baseWhere) conditions.push(source.baseWhere(table));
  if (source.scope && !(await viewer.hasPermission(source.scope.allPermission))) {
    conditions.push(source.scope.where(table, viewer.userId));
  }
  return conditions;
}
