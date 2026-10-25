/**
 * What the documents and fields routes need to know about the draft they
 * work on: a request still being prepared (/api/sign/envelopes/:id) or a
 * template (/api/sign/templates/:id). Both are `sign_envelopes` rows; they
 * differ in permissions, in who may change them and in the event published.
 */

import type { requirePermission } from '@weldsuite/permissions/server';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { Ctx } from './envelopes/shared';

export type SignPermission = Parameters<typeof requirePermission>[0];

export interface DraftScope {
  /** Read the draft's documents. */
  read: SignPermission;
  /** Change its documents and fields. */
  update: SignPermission;
  /** The draft (`:id`) the caller may change, or a `SignError`. */
  loadEditable(c: Ctx): Promise<SignEnvelope>;
  /** The draft (`:id`) the caller may read, or a `SignError`. */
  loadReadable(c: Ctx): Promise<SignEnvelope>;
  /** After a change: publish its entity event. */
  changed(c: Ctx, envelope: SignEnvelope): void;
}
