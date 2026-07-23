import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../../../db';
import { registerEntityProvider, type EntityChannelProvider } from '../registry';

function contactDisplayName(c: {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const fromParts = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  return c.fullName || fromParts || c.email || 'Contact';
}

export const contactEntityProvider: EntityChannelProvider = {
  type: 'contact',
  label: 'Contacts',
  requiredPermission: 'messages:read',

  async resolve({ db, entityId, actingUserId }) {
    const { people: contacts } = schema;

    const [contact] = await db
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        fullName: contacts.fullName,
        email: contacts.email,
      })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), isNull(contacts.deletedAt)))
      .limit(1);

    if (!contact) return null;

    // Contacts have no ownerId / accountManagerId on the table — only the
    // creator is auto-added. Workspace-level `contacts:read` (enforced at the
    // route layer) controls who else can open the channel.
    return {
      displayName: contactDisplayName(contact),
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

  async canAccess({ db, entityId }) {
    // Workspace-level permission is enforced at the route layer; here we only
    // verify the contact exists and isn't soft-deleted, so we don't create
    // channels for ghost entities.
    const { people: contacts } = schema;
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), isNull(contacts.deletedAt)))
      .limit(1);
    return !!contact;
  },
};

registerEntityProvider(contactEntityProvider);
