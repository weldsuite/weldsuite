import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';
import { personDisplayName, personEntityProvider } from './person';

/**
 * LEGACY name for a person's chat. The canonical type is `person`
 * (./person.ts); `contact` stays registered only so channels already created
 * under it remain readable, and the WeldMail customer panel
 * (`components/customer-detail/customer-detail-view.tsx`) still posts with it.
 * Retire it once those rows are renamed to `person` (ask before writing that
 * data migration) and the panel sends `person`.
 *
 * Same record (`people`) and the same visibility as `person`. Left out of the
 * record chat lists.
 */
export const contactEntityProvider: EntityChannelProvider = {
  type: 'contact',
  label: 'Contacts',
  requiredPermission: personEntityProvider.requiredPermission,
  legacy: true,

  async resolve({ db, entityId, actingUserId }) {
    const { people: contacts } = schema;

    const [contact] = await db
      .select({
        displayName: contacts.displayName,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        fullName: contacts.fullName,
        email: contacts.email,
      })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), isNull(contacts.deletedAt)))
      .limit(1);

    if (!contact) return null;

    return {
      displayName: personDisplayName(contact),
      defaultMemberIds: [actingUserId],
    };
  },

  async resolveDetail({ db, entityId }) {
    const { people: contacts } = schema;
    const [contact] = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        fullName: contacts.fullName,
        email: contacts.email,
        directPhone: contacts.directPhone,
        mobilePhone: contacts.mobilePhone,
        title: contacts.title,
        department: contacts.department,
        avatarUrl: contacts.avatarUrl,
        status: contacts.status,
      })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), isNull(contacts.deletedAt)))
      .limit(1);
    return contact ?? null;
  },

  filterVisible(ctx, entityIds) {
    return personEntityProvider.filterVisible(ctx, entityIds);
  },

  canAccess(ctx) {
    return canAccessViaFilter(contactEntityProvider, ctx);
  },
};

registerEntityProvider(contactEntityProvider);
