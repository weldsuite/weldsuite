/**
 * Widget Ticket Routes
 *
 * Public-facing endpoints for customers to create and track tickets via the widget.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, isNull, asc } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { generateId } from '../lib/id';
import { success, error } from '../lib/response';
import {
  syncValuesForEntity,
  hydrateCustomFieldsOne,
  getDefinitionsForTicket,
} from '@weldsuite/db/lib/custom-field-values';

const widgetTicketsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas
// ============================================================================

const createTicketSchema = z.object({
  customerEmail: z.string().email(),
  customerName: z.string().min(1).max(255),
  subject: z.string().min(1).max(500),
  description: z.string().optional(),
  ticketTypeId: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
});

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /tickets/types - List active ticket types (for form rendering)
 */
widgetTicketsRoutes.get('/types', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { helpdeskTicketTypes } = schema;

    const results = await db
      .select({
        id: helpdeskTicketTypes.id,
        name: helpdeskTicketTypes.name,
        description: helpdeskTicketTypes.description,
        icon: helpdeskTicketTypes.icon,
        color: helpdeskTicketTypes.color,
        fields: helpdeskTicketTypes.fields,
      })
      .from(helpdeskTicketTypes)
      .where(
        and(
          eq(helpdeskTicketTypes.isActive, true),
          isNull(helpdeskTicketTypes.deletedAt)
        )
      )
      .orderBy(asc(helpdeskTicketTypes.sortOrder));

    return success(c, results);
  } catch (err) {
    console.error('[Widget] Failed to fetch ticket types:', err);
    return error.internal(c, 'Failed to fetch ticket types');
  }
});

/**
 * GET /tickets - List tickets for a customer by email
 */
widgetTicketsRoutes.get('/', async (c) => {
  const customerEmail = c.req.query('customerEmail');
  if (!customerEmail) {
    return error.badRequest(c, 'customerEmail query parameter is required');
  }

  try {
    const db = c.get('tenantDb');
    const { helpdeskTickets, helpdeskTicketTypes } = schema;

    const results = await db
      .select({
        id: helpdeskTickets.id,
        ticketNumber: helpdeskTickets.ticketNumber,
        subject: helpdeskTickets.subject,
        status: helpdeskTickets.status,
        priority: helpdeskTickets.priority,
        ticketTypeId: helpdeskTickets.ticketTypeId,
        createdAt: helpdeskTickets.createdAt,
        updatedAt: helpdeskTickets.updatedAt,
      })
      .from(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.customerEmail, customerEmail),
          isNull(helpdeskTickets.deletedAt)
        )
      )
      .orderBy(desc(helpdeskTickets.createdAt))
      .limit(50);

    // Fetch ticket types to include names
    const typeIds = [...new Set(results.filter((r) => r.ticketTypeId).map((r) => r.ticketTypeId!))];
    let typeMap: Record<string, string> = {};
    if (typeIds.length > 0) {
      const types = await db
        .select({ id: helpdeskTicketTypes.id, name: helpdeskTicketTypes.name })
        .from(helpdeskTicketTypes)
        .where(isNull(helpdeskTicketTypes.deletedAt));
      typeMap = Object.fromEntries(types.map((t) => [t.id, t.name]));
    }

    const tickets = results.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      ticketTypeName: t.ticketTypeId ? typeMap[t.ticketTypeId] || null : null,
      createdAt: t.createdAt?.toISOString(),
      updatedAt: t.updatedAt?.toISOString(),
    }));

    return success(c, tickets);
  } catch (err) {
    console.error('[Widget] Failed to fetch tickets:', err);
    return error.internal(c, 'Failed to fetch tickets');
  }
});

/**
 * GET /tickets/:id - Get single ticket detail for customer
 */
widgetTicketsRoutes.get('/:id', async (c) => {
  const ticketId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { helpdeskTickets, helpdeskTicketTypes } = schema;

    const results = await db
      .select({
        id: helpdeskTickets.id,
        ticketNumber: helpdeskTickets.ticketNumber,
        subject: helpdeskTickets.subject,
        description: helpdeskTickets.description,
        status: helpdeskTickets.status,
        priority: helpdeskTickets.priority,
        ticketTypeId: helpdeskTickets.ticketTypeId,
        customFields: helpdeskTickets.customFields,
        customerEmail: helpdeskTickets.customerEmail,
        customerName: helpdeskTickets.customerName,
        assigneeName: helpdeskTickets.assigneeName,
        createdAt: helpdeskTickets.createdAt,
        updatedAt: helpdeskTickets.updatedAt,
        // Joined ticket type fields
        ticketTypeName: helpdeskTicketTypes.name,
        ticketTypeStates: helpdeskTicketTypes.states,
        ticketTypeFields: helpdeskTicketTypes.fields,
      })
      .from(helpdeskTickets)
      .leftJoin(helpdeskTicketTypes, eq(helpdeskTickets.ticketTypeId, helpdeskTicketTypes.id))
      .where(
        and(
          eq(helpdeskTickets.id, ticketId),
          isNull(helpdeskTickets.deletedAt)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return error.notFound(c, 'Ticket', ticketId);
    }

    const t = results[0];
    // Pile B: serve custom field values from the typed table (blob fallback
    // during the migration window — see hydrateCustomFields).
    const hydrated = await hydrateCustomFieldsOne(db, 'ticket', {
      id: t.id,
      customFields: t.customFields,
    });

    return success(c, {
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      description: t.description,
      status: t.status,
      priority: t.priority,
      ticketTypeId: t.ticketTypeId,
      customFields: hydrated?.customFields || {},
      customerEmail: t.customerEmail,
      customerName: t.customerName,
      assigneeName: t.assigneeName,
      ticketTypeName: t.ticketTypeName || null,
      ticketTypeStates: t.ticketTypeStates || null,
      ticketTypeFields: t.ticketTypeFields || null,
      createdAt: t.createdAt?.toISOString(),
      updatedAt: t.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[Widget] Failed to fetch ticket:', err);
    return error.internal(c, 'Failed to fetch ticket');
  }
});

/**
 * POST /tickets - Create ticket from widget
 */
widgetTicketsRoutes.post('/', zValidator('json', createTicketSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskTickets, contacts } = schema;

    // Auto-resolve contactId
    let resolvedContactId: string | null = null;
    try {
      const contactMatch = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.email, data.customerEmail), isNull(contacts.deletedAt)))
        .limit(1);
      if (contactMatch.length > 0) {
        resolvedContactId = contactMatch[0].id;
      }
    } catch {
      // contacts table may not exist, skip
    }

    const id = generateId('tkt');
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date();

    await db.insert(helpdeskTickets).values({
      id,
      ticketNumber,
      subject: data.subject,
      description: data.description,
      priority: 'normal',
      status: 'open',
      category: 'general_inquiry',
      channel: 'web',
      customerEmail: data.customerEmail,
      customerName: data.customerName,
      contactId: resolvedContactId,
      ticketTypeId: data.ticketTypeId,
      customFields: data.customFields || {},
      createdAt: now,
      updatedAt: now,
    });

    // Pile B dual-write: mirror the ticket-type form values into the typed
    // values table, scoped to this ticket's type. Best-effort by design — the
    // blob above stays the source of truth until Phase 4.
    const ticketDefs = await getDefinitionsForTicket(db, data.ticketTypeId);
    await syncValuesForEntity(db, 'ticket', id, data.customFields, generateId, ticketDefs);

    return success(c, {
      id,
      ticketNumber,
      subject: data.subject,
      status: 'open',
      createdAt: now.toISOString(),
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to create ticket:', err);
    return error.internal(c, 'Failed to create ticket');
  }
});

export { widgetTicketsRoutes };
