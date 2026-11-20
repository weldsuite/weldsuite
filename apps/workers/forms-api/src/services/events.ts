/**
 * Entity-event payloads (packages/core/entity-events/src/events/forms.ts).
 * The definition never goes on the bus, only ids, titles and states.
 */

import type { DataFor } from '@weldsuite/entity-events/events';
import type { schema } from '@weldsuite/worker-kit/db';

type FormRow = typeof schema.forms.$inferSelect;

export type FormEventData = DataFor<'form'>;
export type FormResponseEventData = DataFor<'form_response'>;
export type FormSupportEventData = DataFor<'form_folder'>;
export type FormInvitationEventData = DataFor<'form_invitation'>;

export function formEventData(form: Pick<FormRow, 'id' | 'title' | 'status' | 'publicId' | 'ownerUserId'>, extra: Partial<FormEventData> = {}): FormEventData {
  return {
    id: form.id,
    title: form.title,
    status: form.status,
    publicId: form.publicId,
    ownerUserId: form.ownerUserId,
    ...extra,
  };
}

export function supportEventData(row: { id: string; name: string }): FormSupportEventData {
  return { id: row.id, name: row.name };
}
