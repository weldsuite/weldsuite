/** Helpers the template routes share: the `sign_template` entity event. */

import { publishEntityEvent } from '@weldsuite/entity-events';
import type { DataFor } from '@weldsuite/entity-events/events';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { Ctx } from '../envelopes/shared';

/** The `sign_template` event payload: id and title only. */
export function templateEventData(template: SignEnvelope): DataFor<'sign_template'> {
  return { id: template.id, title: template.title };
}

/** `sign_template:updated` after a change to a template's documents, roles or fields. */
export function publishTemplateUpdated(c: Ctx, template: SignEnvelope): void {
  publishEntityEvent({ c, entityType: 'sign_template', entityId: template.id, action: 'updated', data: templateEventData(template) });
}
