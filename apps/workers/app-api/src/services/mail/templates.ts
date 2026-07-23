/**
 * Mail template service.
 *
 * Templates are workspace-level reusable bodies with `{{var}}` placeholder
 * substitution. The render path HTML-escapes substituted values when
 * rendering into `htmlContent` (api-worker did not — fixed here so user
 * input can't smuggle script tags through a template). Subject and text
 * stay literal.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';

const { mailTemplates } = schema;

type TemplateType = 'marketing' | 'transactional' | 'notification' | 'newsletter' | 'welcome' | 'custom';

export class MailTemplateError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'MISSING_VARIABLES',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MailTemplateError';
  }
}

export interface ListTemplatesFilters {
  type?: TemplateType;
  category?: string;
  isActive?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listTemplates(db: Database, filters: ListTemplatesFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions: SQL[] = [isNull(mailTemplates.deletedAt)!];
  if (filters.type) conditions.push(eq(mailTemplates.type, filters.type));
  if (filters.category) conditions.push(eq(mailTemplates.category, filters.category));
  if (filters.isActive !== undefined) conditions.push(eq(mailTemplates.isActive, filters.isActive));

  if (filters.cursor) {
    const [cur] = await db
      .select({ createdAt: mailTemplates.createdAt, id: mailTemplates.id })
      .from(mailTemplates)
      .where(eq(mailTemplates.id, filters.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${mailTemplates.createdAt} < ${cur.createdAt} OR (${mailTemplates.createdAt} = ${cur.createdAt} AND ${mailTemplates.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const countWhere = and(...(filters.cursor ? conditions.slice(0, -1) : conditions));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(mailTemplates)
      .where(where)
      .orderBy(desc(mailTemplates.createdAt), desc(mailTemplates.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailTemplates).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  return { data, hasMore, cursor, totalCount: Number(countRes[0]?.count ?? 0) };
}

export async function getTemplate(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailTemplates)
    .where(and(eq(mailTemplates.id, id), isNull(mailTemplates.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listTemplateCategories(db: Database): Promise<string[]> {
  const rows = await db
    .select({ category: mailTemplates.category })
    .from(mailTemplates)
    .where(and(isNull(mailTemplates.deletedAt), sql`${mailTemplates.category} IS NOT NULL`))
    .groupBy(mailTemplates.category);
  return rows.map((r) => r.category!).filter(Boolean);
}

export interface TemplateInput {
  name: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  category?: string;
  description?: string;
  type?: TemplateType;
  purpose?: string;
  variables?: Array<{ name: string; type: 'text' | 'number' | 'date' | 'boolean' | 'list'; required?: boolean; defaultValue?: unknown; description?: string }>;
  requiredVariables?: string[];
  tags?: string[];
  isActive?: boolean;
  isDefault?: boolean;
}

export async function createTemplate(db: Database, data: TemplateInput) {
  const id = generateId('tpl');
  const now = new Date();
  await db.insert(mailTemplates).values({
    id,
    name: data.name,
    subject: data.subject,
    htmlContent: data.htmlContent,
    textContent: data.textContent,
    category: data.category,
    description: data.description,
    type: data.type ?? 'custom',
    purpose: data.purpose,
    variables: data.variables,
    requiredVariables: data.requiredVariables,
    tags: data.tags,
    isActive: data.isActive ?? true,
    isDefault: data.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailTemplates).where(eq(mailTemplates.id, id));
  return row!;
}

export async function updateTemplate(db: Database, id: string, data: Partial<TemplateInput>) {
  const [existing] = await db
    .select()
    .from(mailTemplates)
    .where(and(eq(mailTemplates.id, id), isNull(mailTemplates.deletedAt)))
    .limit(1);
  if (!existing) throw new MailTemplateError('NOT_FOUND', 'Template not found');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailTemplates)
    .set(patch as typeof mailTemplates.$inferInsert)
    .where(eq(mailTemplates.id, id));
  const [after] = await db.select().from(mailTemplates).where(eq(mailTemplates.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteTemplate(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailTemplates)
    .where(and(eq(mailTemplates.id, id), isNull(mailTemplates.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(mailTemplates)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailTemplates.id, id));
  return existing;
}

export async function duplicateTemplate(db: Database, id: string) {
  const source = await getTemplate(db, id);
  if (!source) throw new MailTemplateError('NOT_FOUND', 'Template not found');
  const newId = generateId('tpl');
  const now = new Date();
  await db.insert(mailTemplates).values({
    id: newId,
    name: `${source.name} (Copy)`,
    subject: source.subject,
    htmlContent: source.htmlContent,
    textContent: source.textContent,
    category: source.category,
    description: source.description,
    variables: source.variables,
    requiredVariables: source.requiredVariables,
    type: source.type,
    purpose: source.purpose,
    tags: source.tags,
    isActive: source.isActive,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailTemplates).where(eq(mailTemplates.id, newId));
  return row!;
}

/**
 * Render a template against a variable bag. HTML-escapes substituted
 * values when rendering into `htmlContent` so untrusted variable values
 * can't inject markup. Subject and text body are rendered verbatim.
 *
 * Bumps `usageCount` and stamps `lastUsedAt` as a side-effect.
 */
export async function renderTemplate(
  db: Database,
  id: string,
  variables: Record<string, unknown>,
) {
  const template = await getTemplate(db, id);
  if (!template) throw new MailTemplateError('NOT_FOUND', 'Template not found');

  const required = (template.requiredVariables as string[]) ?? [];
  const missing = required.filter((v) => !(v in variables));
  if (missing.length > 0) {
    throw new MailTemplateError(
      'MISSING_VARIABLES',
      `Missing required variables: ${missing.join(', ')}`,
      { missing },
    );
  }

  const renderedSubject = substitute(template.subject, variables, false);
  const renderedHtml = substitute(template.htmlContent, variables, true);
  const renderedText = template.textContent ? substitute(template.textContent, variables, false) : null;

  await db
    .update(mailTemplates)
    .set({
      usageCount: sql`COALESCE(${mailTemplates.usageCount}, 0) + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailTemplates.id, id));

  return { subject: renderedSubject, htmlContent: renderedHtml, textContent: renderedText };
}

function substitute(input: string, vars: Record<string, unknown>, escapeHtml: boolean): string {
  return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const raw = String(vars[key] ?? '');
    return escapeHtml ? htmlEscape(raw) : raw;
  });
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
