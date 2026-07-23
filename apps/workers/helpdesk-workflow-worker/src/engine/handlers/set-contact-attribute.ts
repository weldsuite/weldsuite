import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';
import { ensureCustomFieldDefinition, setValues } from '@weldsuite/db/lib/custom-field-values';

const DIRECT_FIELDS = new Set([
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'company',
]);

const FIELD_COLUMN_MAP: Record<string, string> = {
  firstName: 'firstName',
  lastName: 'lastName',
  fullName: 'fullName',
  email: 'email',
  phone: 'directPhone',
  company: 'department',
};

export const setContactAttributeHandler: StepHandler = {
  type: 'set_contact_attribute',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const attribute = String(ctx.inputs.attribute);
    const value = ctx.inputs.value;

    const [conversation] = await db
      .select({
        personId: schema.helpdeskConversations.personId,
        contactId: schema.helpdeskConversations.contactId,
      })
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    const personId = conversation?.personId ?? conversation?.contactId;
    if (!personId) {
      return { success: false, error: 'No person associated with this conversation', conversationId };
    }

    if (DIRECT_FIELDS.has(attribute)) {
      const columnName = FIELD_COLUMN_MAP[attribute] || attribute;
      await db
        .update(schema.people)
        .set({
          [columnName]: value,
          updatedAt: new Date(),
        })
        .where(eq(schema.people.id, personId));
    } else {
      const [person] = await db
        .select({ customFields: schema.people.customFields })
        .from(schema.people)
        .where(eq(schema.people.id, personId))
        .limit(1);

      const existingFields = (person?.customFields as Record<string, unknown>) ?? {};
      const updatedFields = { ...existingFields, [attribute]: value };

      await db
        .update(schema.people)
        .set({
          customFields: updatedFields,
          updatedAt: new Date(),
        })
        .where(eq(schema.people.id, personId));

      // Pile B dual-write: mirror the attribute into the typed value store,
      // auto-creating a text definition when the attribute has none yet. Blob
      // above stays the source of truth until Phase 4; never fail the step.
      try {
        const def = await ensureCustomFieldDefinition(db, generateId, 'person', attribute);
        await setValues(db, 'person', personId, { [attribute]: value }, {
          generateId,
          definitions: [def],
        });
      } catch (err) {
        console.warn(`[set-contact-attribute] value mirror failed for person ${personId}`, err);
      }
    }

    return { success: true, attribute, value, personId };
  },
};
