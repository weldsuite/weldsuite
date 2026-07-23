

/**
 * Extended session type for application use
 * Matches the format expected by api-auth.ts and other consumers
 */
export interface AppSession {
  user: {
    id: string;
    email?: string;
    name?: string;
    workspaceId?: string;
  };
  accessToken?: string;
}

/**
 * Auth function that returns a session-like object for backward compatibility
 * This wraps Clerk's auth to provide a consistent interface
 */
export async function auth(): Promise<AppSession | null> {
  try {
    const { userId, orgId, getToken } = await clerkAuth();

    if (!userId) {
      return null;
    }

    const user = await currentUser();
    const token = await getToken();

    return {
      user: {
        id: userId,
        email: user?.emailAddresses?.[0]?.emailAddress,
        name: user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : undefined,
        workspaceId: orgId || undefined,
      },
      accessToken: token || undefined,
    };
  } catch (error) {
    console.error('[Auth] Error in auth():', error);
    return null;
  }
}

/**
 * Get the access token for API authentication
 * Uses Clerk's getToken method to retrieve JWT
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const { getToken } = await clerkAuth();
    // Get a token for your backend - you can specify a template if needed
    const token = await getToken();
    return token;
  } catch (error) {
    console.error('[Auth] Error getting access token:', error);
    return null;
  }
}

/**
 * Get server session with user and token info
 * Alias for auth() for backward compatibility
 */
export const getServerSession = auth;

/**
 * Server user type
 */
interface ServerUser {
  id: string;
  email?: string;
  name?: string;
  imageUrl?: string;
}

/**
 * Workspace type
 */
interface Workspace {
  id: string;
  name: string;
  slug?: string;
  imageUrl?: string;
}

/**
 * Get the server user from Clerk
 */
async function getServerUser(): Promise<ServerUser | null> {
  try {
    const { userId } = await clerkAuth();

    if (!userId) {
      return null;
    }

    const user = await currentUser();

    if (!user) {
      return null;
    }

    return {
      id: userId,
      email: user.emailAddresses?.[0]?.emailAddress,
      name: user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : undefined,
      imageUrl: user.imageUrl,
    };
  } catch (error) {
    console.error('[Auth] Error getting server user:', error);
    return null;
  }
}

/**
 * Get user workspaces (Clerk organizations)
 * Fetches all workspaces the user has access to and syncs with database
 */
async function getUserWorkspaces(): Promise<Workspace[]> {
  try {
    const { userId } = await clerkAuth();
    if (!userId) return [];

    // Get all organizations the user is a member of
    const clerk = await clerkClient();
    const memberships = await clerk.users.getOrganizationMembershipList({ userId });

    if (!memberships.data || memberships.data.length === 0) {
      return [];
    }

    // Return all organizations
    return memberships.data.map(m => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug || undefined,
    }));
  } catch (error) {
    console.error('[Auth] Error getting user workspaces:', error);
    return [];
  }
}

/**
 * Get current user - alias for getServerUser
 */
const getCurrentUser = getServerUser;

/**
 * Get the current workspace ID from Clerk organization
 */
async function getWorkspaceId(): Promise<string | null> {
  try {
    const { orgId } = await clerkAuth();
    return orgId || null;
  } catch (error) {
    console.error('[Auth] Error getting workspace ID:', error);
    return null;
  }
}
