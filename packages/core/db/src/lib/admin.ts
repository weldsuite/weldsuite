// TODO: This file has platform-specific dependencies that need to be made injectable:
// - @clerk/nextjs/server (auth) - used for admin authentication
// - next/navigation (redirect) - used for redirects
// These dependencies will be addressed in a future phase to make this package reusable.

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { masterDb } from './master';
import * as masterSchema from '../schema/master';

/**
 * Get the master database instance for admin operations
 * Use for: workspaces, plans, domain pricing, system settings
 */
export function getMasterDb() {
  return masterDb;
}

/**
 * @deprecated Shared database has been removed. Each workspace has its own database.
 * Use getTenantDbByWorkspaceId(workspaceId) to query a specific workspace.
 */
export function getSharedDb(): never {
  throw new Error(
    'Shared database has been removed. Each workspace has its own database. ' +
    'Use getTenantDbByWorkspaceId(workspaceId) to query a specific workspace.'
  );
}

/**
 * Check if the current user is an admin
 * Returns the user ID if admin, throws/redirects otherwise
 *
 * Requires Clerk session token customization:
 * In Clerk Dashboard > Sessions > Customize session token, add:
 * { "metadata": "{{user.public_metadata}}" }
 */
export async function requireAdmin(): Promise<{ userId: string }> {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    redirect('/auth/sign-in');
  }

  // Check for admin role in user's public metadata
  // This requires customizing the session token in Clerk Dashboard
  const metadata = (sessionClaims as { metadata?: { role?: string } } | null)?.metadata;
  const isAdminRole = metadata?.role === 'admin';

  if (!isAdminRole) {
    redirect('/unauthorized');
  }

  return { userId };
}

/**
 * Check if user is admin without redirecting
 * Returns true if admin, false otherwise
 */
export async function isAdmin(): Promise<boolean> {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    return false;
  }

  const metadata = (sessionClaims as { metadata?: { role?: string } } | null)?.metadata;
  return metadata?.role === 'admin';
}

// Helper to generate IDs
function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

/**
 * Admin database operations for workspaces
 */
export const adminWorkspaces = {
  async findMany() {
    const results = await masterDb
      .select({
        workspace: masterSchema.workspaces,
        plan: masterSchema.plans,
      })
      .from(masterSchema.workspaces)
      .leftJoin(masterSchema.plans, eq(masterSchema.workspaces.planId, masterSchema.plans.id))
      .orderBy(desc(masterSchema.workspaces.createdAt));

    return results.map(r => ({
      ...r.workspace,
      plan: r.plan,
    }));
  },

  async findOne(id: string) {
    const [result] = await masterDb
      .select({
        workspace: masterSchema.workspaces,
        plan: masterSchema.plans,
      })
      .from(masterSchema.workspaces)
      .leftJoin(masterSchema.plans, eq(masterSchema.workspaces.planId, masterSchema.plans.id))
      .where(eq(masterSchema.workspaces.id, id));

    if (!result) return null;

    return {
      ...result.workspace,
      plan: result.plan,
    };
  },

  async update(id: string, data: Partial<masterSchema.NewWorkspace>) {
    const [updated] = await masterDb
      .update(masterSchema.workspaces)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.id, id))
      .returning();
    return updated;
  },

  async suspend(id: string) {
    return this.update(id, { isActive: false });
  },

  async activate(id: string) {
    return this.update(id, { isActive: true });
  },

  async delete(id: string) {
    // Soft delete by deactivating
    return this.suspend(id);
  },

  async getStats() {
    // Get all plans for counting
    const plans = await masterDb
      .select({ id: masterSchema.plans.id, slug: masterSchema.plans.slug })
      .from(masterSchema.plans)
      .where(isNull(masterSchema.plans.deletedAt));

    const [stats] = await masterDb
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${masterSchema.workspaces.isActive} = true)::int`,
        inactive: sql<number>`count(*) filter (where ${masterSchema.workspaces.isActive} = false)::int`,
        noPlan: sql<number>`count(*) filter (where ${masterSchema.workspaces.planId} is null)::int`,
      })
      .from(masterSchema.workspaces);

    // Count workspaces per plan
    const planCounts = await masterDb
      .select({
        planId: masterSchema.workspaces.planId,
        count: sql<number>`count(*)::int`,
      })
      .from(masterSchema.workspaces)
      .groupBy(masterSchema.workspaces.planId);

    // Build plan stats by slug
    const planStats: Record<string, number> = {};
    for (const plan of plans) {
      const count = planCounts.find(pc => pc.planId === plan.id)?.count || 0;
      planStats[plan.slug] = count;
    }

    return {
      ...stats,
      ...planStats,
    };
  },
};

/**
 * Admin database operations for plans
 */
export const adminPlans = {
  async findMany() {
    return masterDb
      .select()
      .from(masterSchema.plans)
      .where(isNull(masterSchema.plans.deletedAt))
      .orderBy(masterSchema.plans.sortOrder);
  },

  async findOne(id: string) {
    const [plan] = await masterDb
      .select()
      .from(masterSchema.plans)
      .where(and(
        eq(masterSchema.plans.id, id),
        isNull(masterSchema.plans.deletedAt)
      ));
    return plan || null;
  },

  async findBySlug(slug: string) {
    const [plan] = await masterDb
      .select()
      .from(masterSchema.plans)
      .where(and(
        eq(masterSchema.plans.slug, slug),
        isNull(masterSchema.plans.deletedAt)
      ));
    return plan || null;
  },

  async create(data: Omit<masterSchema.NewPlan, 'id'>) {
    const [plan] = await masterDb
      .insert(masterSchema.plans)
      .values({
        id: generateId('plan'),
        ...data,
      })
      .returning();
    return plan;
  },

  async update(id: string, data: Partial<masterSchema.NewPlan>) {
    const [updated] = await masterDb
      .update(masterSchema.plans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.plans.id, id))
      .returning();
    return updated;
  },

  async delete(id: string) {
    // Soft delete
    return this.update(id, { deletedAt: new Date() });
  },
};

/**
 * Admin database operations for domain pricing
 */
export const adminDomainPricing = {
  async findMany() {
    return masterDb
      .select()
      .from(masterSchema.hostDomainPricing)
      .orderBy(masterSchema.hostDomainPricing.tld);
  },

  async findOne(id: string) {
    const [pricing] = await masterDb
      .select()
      .from(masterSchema.hostDomainPricing)
      .where(eq(masterSchema.hostDomainPricing.id, id));
    return pricing || null;
  },

  async create(data: Omit<masterSchema.NewHostDomainPricing, 'id'>) {
    const [pricing] = await masterDb
      .insert(masterSchema.hostDomainPricing)
      .values({
        id: generateId('dp'),
        ...data,
      })
      .returning();
    return pricing;
  },

  async update(id: string, data: Partial<masterSchema.NewHostDomainPricing>) {
    const [updated] = await masterDb
      .update(masterSchema.hostDomainPricing)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.hostDomainPricing.id, id))
      .returning();
    return updated;
  },

  async delete(id: string) {
    await masterDb
      .delete(masterSchema.hostDomainPricing)
      .where(eq(masterSchema.hostDomainPricing.id, id));
  },
};

/**
 * Admin database operations for system settings
 */
export const adminSettings = {
  async findMany(category?: string) {
    if (category) {
      return masterDb
        .select()
        .from(masterSchema.systemSettings)
        .where(eq(masterSchema.systemSettings.category, category))
        .orderBy(masterSchema.systemSettings.key);
    }
    return masterDb
      .select()
      .from(masterSchema.systemSettings)
      .orderBy(masterSchema.systemSettings.category, masterSchema.systemSettings.key);
  },

  async findByKey(key: string) {
    const [setting] = await masterDb
      .select()
      .from(masterSchema.systemSettings)
      .where(eq(masterSchema.systemSettings.key, key));
    return setting || null;
  },

  async upsert(key: string, value: unknown, options?: { category?: string; description?: string; updatedBy?: string }) {
    const existing = await this.findByKey(key);

    if (existing) {
      const [updated] = await masterDb
        .update(masterSchema.systemSettings)
        .set({
          value,
          updatedAt: new Date(),
          updatedBy: options?.updatedBy,
        })
        .where(eq(masterSchema.systemSettings.key, key))
        .returning();
      return updated;
    }

    const [created] = await masterDb
      .insert(masterSchema.systemSettings)
      .values({
        id: generateId('set'),
        key,
        value,
        category: options?.category || 'general',
        description: options?.description,
        updatedBy: options?.updatedBy,
      })
      .returning();
    return created;
  },

  async delete(key: string) {
    await masterDb
      .delete(masterSchema.systemSettings)
      .where(eq(masterSchema.systemSettings.key, key));
  },
};

/**
 * @deprecated Admin operations for users across workspaces are no longer supported.
 * Each workspace has its own database, so cross-workspace user queries must be done
 * by iterating through workspaces using getTenantDbByWorkspaceId().
 */
export const adminUsers = {
  async findMany(): Promise<never> {
    throw new Error(
      'adminUsers.findMany() is no longer supported. Each workspace has its own database. ' +
      'Query users through specific workspace databases using getTenantDbByWorkspaceId().'
    );
  },

  async findOne(_id: string): Promise<never> {
    throw new Error(
      'adminUsers.findOne() is no longer supported. Each workspace has its own database. ' +
      'Query users through specific workspace databases using getTenantDbByWorkspaceId().'
    );
  },

  async findByUserId(_userId: string): Promise<never> {
    throw new Error(
      'adminUsers.findByUserId() is no longer supported. Each workspace has its own database. ' +
      'Query users through specific workspace databases using getTenantDbByWorkspaceId().'
    );
  },

  async update(_id: string, _data: Record<string, unknown>): Promise<never> {
    throw new Error(
      'adminUsers.update() is no longer supported. Each workspace has its own database. ' +
      'Update users through specific workspace databases using getTenantDbByWorkspaceId().'
    );
  },

  async delete(_id: string): Promise<never> {
    throw new Error(
      'adminUsers.delete() is no longer supported. Each workspace has its own database. ' +
      'Delete users through specific workspace databases using getTenantDbByWorkspaceId().'
    );
  },

  async getStats(): Promise<never> {
    throw new Error(
      'adminUsers.getStats() is no longer supported. Each workspace has its own database. ' +
      'Aggregate stats must be computed by iterating through workspaces.'
    );
  },
};

/**
 * Admin database operations for enterprise inquiries
 */
type InquiryStatus = 'new' | 'contacted' | 'in_progress' | 'closed' | 'converted';

export const adminEnterpriseInquiries = {
  async findMany(status?: InquiryStatus) {
    if (status) {
      return masterDb
        .select()
        .from(masterSchema.enterpriseInquiries)
        .where(eq(masterSchema.enterpriseInquiries.status, status))
        .orderBy(desc(masterSchema.enterpriseInquiries.createdAt));
    }
    return masterDb
      .select()
      .from(masterSchema.enterpriseInquiries)
      .orderBy(desc(masterSchema.enterpriseInquiries.createdAt));
  },

  async findOne(id: string) {
    const [inquiry] = await masterDb
      .select()
      .from(masterSchema.enterpriseInquiries)
      .where(eq(masterSchema.enterpriseInquiries.id, id));
    return inquiry || null;
  },

  async create(data: Omit<masterSchema.NewEnterpriseInquiry, 'id'>) {
    const [inquiry] = await masterDb
      .insert(masterSchema.enterpriseInquiries)
      .values({
        id: generateId('inq'),
        ...data,
      })
      .returning();
    return inquiry;
  },

  async update(id: string, data: Partial<masterSchema.NewEnterpriseInquiry>) {
    const [updated] = await masterDb
      .update(masterSchema.enterpriseInquiries)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.enterpriseInquiries.id, id))
      .returning();
    return updated;
  },

  async updateStatus(id: string, status: 'new' | 'contacted' | 'in_progress' | 'closed' | 'converted', notes?: string) {
    const updateData: Partial<masterSchema.NewEnterpriseInquiry> = {
      status,
      updatedAt: new Date(),
    };

    if (notes) {
      updateData.notes = notes;
    }

    if (status === 'contacted') {
      updateData.contactedAt = new Date();
    } else if (status === 'closed' || status === 'converted') {
      updateData.closedAt = new Date();
    }

    return this.update(id, updateData);
  },

  async getStats() {
    const [stats] = await masterDb
      .select({
        total: sql<number>`count(*)::int`,
        new: sql<number>`count(*) filter (where ${masterSchema.enterpriseInquiries.status} = 'new')::int`,
        contacted: sql<number>`count(*) filter (where ${masterSchema.enterpriseInquiries.status} = 'contacted')::int`,
        inProgress: sql<number>`count(*) filter (where ${masterSchema.enterpriseInquiries.status} = 'in_progress')::int`,
        closed: sql<number>`count(*) filter (where ${masterSchema.enterpriseInquiries.status} = 'closed')::int`,
        converted: sql<number>`count(*) filter (where ${masterSchema.enterpriseInquiries.status} = 'converted')::int`,
      })
      .from(masterSchema.enterpriseInquiries);
    return stats;
  },
};

/**
 * Admin database operations for feature requests
 */
export const adminFeatureRequests = {
  async findMany(options?: {
    status?: masterSchema.FeatureStatus;
    type?: masterSchema.FeatureType;
    sortBy?: 'votes' | 'newest' | 'oldest';
    limit?: number;
  }) {
    let query = masterDb
      .select()
      .from(masterSchema.featureRequests);

    // Apply filters
    const conditions = [];
    if (options?.status) {
      conditions.push(eq(masterSchema.featureRequests.status, options.status));
    }
    if (options?.type) {
      conditions.push(eq(masterSchema.featureRequests.type, options.type));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    // Apply sorting
    if (options?.sortBy === 'votes') {
      query = query.orderBy(desc(masterSchema.featureRequests.voteCount), desc(masterSchema.featureRequests.createdAt)) as typeof query;
    } else if (options?.sortBy === 'oldest') {
      query = query.orderBy(masterSchema.featureRequests.createdAt) as typeof query;
    } else {
      // Default: newest first
      query = query.orderBy(desc(masterSchema.featureRequests.createdAt)) as typeof query;
    }

    // Apply limit
    if (options?.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    return query;
  },

  async findOne(id: string) {
    const [request] = await masterDb
      .select()
      .from(masterSchema.featureRequests)
      .where(eq(masterSchema.featureRequests.id, id));
    return request || null;
  },

  async create(data: Omit<masterSchema.NewFeatureRequest, 'id'>) {
    const [request] = await masterDb
      .insert(masterSchema.featureRequests)
      .values({
        id: generateId('fr'),
        ...data,
      })
      .returning();
    return request;
  },

  async update(id: string, data: Partial<masterSchema.NewFeatureRequest>) {
    const [updated] = await masterDb
      .update(masterSchema.featureRequests)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.featureRequests.id, id))
      .returning();
    return updated;
  },

  async vote(id: string, userId: string) {
    // Get current request
    const request = await this.findOne(id);
    if (!request) return null;

    // Check if user already voted
    const voters = (request.voters || []) as string[];
    if (voters.includes(userId)) {
      return request; // Already voted
    }

    // Add vote
    const [updated] = await masterDb
      .update(masterSchema.featureRequests)
      .set({
        voters: [...voters, userId],
        voteCount: request.voteCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(masterSchema.featureRequests.id, id))
      .returning();
    return updated;
  },

  async unvote(id: string, userId: string) {
    // Get current request
    const request = await this.findOne(id);
    if (!request) return null;

    // Check if user has voted
    const voters = (request.voters || []) as string[];
    if (!voters.includes(userId)) {
      return request; // Never voted
    }

    // Remove vote
    const [updated] = await masterDb
      .update(masterSchema.featureRequests)
      .set({
        voters: voters.filter(v => v !== userId),
        voteCount: Math.max(0, request.voteCount - 1),
        updatedAt: new Date(),
      })
      .where(eq(masterSchema.featureRequests.id, id))
      .returning();
    return updated;
  },

  async toggleVote(id: string, userId: string) {
    // Get current request
    const request = await this.findOne(id);
    if (!request) return null;

    const voters = (request.voters || []) as string[];
    const hasVoted = voters.includes(userId);

    if (hasVoted) {
      return this.unvote(id, userId);
    } else {
      return this.vote(id, userId);
    }
  },

  async delete(id: string) {
    await masterDb
      .delete(masterSchema.featureRequests)
      .where(eq(masterSchema.featureRequests.id, id));
  },

  async getStats() {
    const [stats] = await masterDb
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'open')::int`,
        underReview: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'under_review')::int`,
        planned: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'planned')::int`,
        inProgress: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'in_progress')::int`,
        completed: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'completed')::int`,
        declined: sql<number>`count(*) filter (where ${masterSchema.featureRequests.status} = 'declined')::int`,
        features: sql<number>`count(*) filter (where ${masterSchema.featureRequests.type} = 'feature')::int`,
        bugs: sql<number>`count(*) filter (where ${masterSchema.featureRequests.type} = 'bug')::int`,
        improvements: sql<number>`count(*) filter (where ${masterSchema.featureRequests.type} = 'improvement')::int`,
      })
      .from(masterSchema.featureRequests);
    return stats;
  },
};

/**
 * Admin database operations for app catalog
 */
export const adminAppCatalog = {
  async findMany(options?: { includeInactive?: boolean }) {
    if (options?.includeInactive) {
      return masterDb
        .select()
        .from(masterSchema.appCatalog)
        .orderBy(masterSchema.appCatalog.sortOrder);
    }
    return masterDb
      .select()
      .from(masterSchema.appCatalog)
      .where(eq(masterSchema.appCatalog.isActive, true))
      .orderBy(masterSchema.appCatalog.sortOrder);
  },

  async findOne(id: string) {
    const [app] = await masterDb
      .select()
      .from(masterSchema.appCatalog)
      .where(eq(masterSchema.appCatalog.id, id));
    return app || null;
  },

  async findByCode(code: string) {
    const [app] = await masterDb
      .select()
      .from(masterSchema.appCatalog)
      .where(eq(masterSchema.appCatalog.code, code));
    return app || null;
  },

  async create(data: Omit<masterSchema.NewAppCatalogEntry, 'id'>) {
    const [app] = await masterDb
      .insert(masterSchema.appCatalog)
      .values({
        id: generateId('app'),
        ...data,
      })
      .returning();
    return app;
  },

  async update(id: string, data: Partial<masterSchema.NewAppCatalogEntry>) {
    const [updated] = await masterDb
      .update(masterSchema.appCatalog)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(masterSchema.appCatalog.id, id))
      .returning();
    return updated;
  },

  async delete(id: string) {
    // First delete all screenshots for this app
    await masterDb
      .delete(masterSchema.appScreenshots)
      .where(eq(masterSchema.appScreenshots.appId, id));

    // Then delete the app
    await masterDb
      .delete(masterSchema.appCatalog)
      .where(eq(masterSchema.appCatalog.id, id));
  },

  async getStats() {
    const [stats] = await masterDb
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${masterSchema.appCatalog.isActive} = true)::int`,
        published: sql<number>`count(*) filter (where ${masterSchema.appCatalog.isPublished} = true)::int`,
        inactive: sql<number>`count(*) filter (where ${masterSchema.appCatalog.isActive} = false)::int`,
      })
      .from(masterSchema.appCatalog);
    return stats;
  },
};

/**
 * Admin database operations for app screenshots
 */
export const adminAppScreenshots = {
  async findByAppId(appId: string) {
    return masterDb
      .select()
      .from(masterSchema.appScreenshots)
      .where(eq(masterSchema.appScreenshots.appId, appId))
      .orderBy(masterSchema.appScreenshots.sortOrder);
  },

  async findOne(id: string) {
    const [screenshot] = await masterDb
      .select()
      .from(masterSchema.appScreenshots)
      .where(eq(masterSchema.appScreenshots.id, id));
    return screenshot || null;
  },

  async create(data: Omit<masterSchema.NewAppScreenshot, 'id'>) {
    // Get max sort order for this app
    const existing = await this.findByAppId(data.appId);
    const maxOrder = existing.length > 0
      ? Math.max(...existing.map(s => s.sortOrder))
      : -1;

    const [screenshot] = await masterDb
      .insert(masterSchema.appScreenshots)
      .values({
        id: generateId('ss'),
        ...data,
        sortOrder: data.sortOrder ?? maxOrder + 1,
      })
      .returning();
    return screenshot;
  },

  async delete(id: string) {
    await masterDb
      .delete(masterSchema.appScreenshots)
      .where(eq(masterSchema.appScreenshots.id, id));
  },

  async reorder(appId: string, screenshotIds: string[]) {
    // Update sort order for each screenshot
    for (const [i, screenshotId] of screenshotIds.entries()) {
      await masterDb
        .update(masterSchema.appScreenshots)
        .set({ sortOrder: i })
        .where(and(
          eq(masterSchema.appScreenshots.id, screenshotId),
          eq(masterSchema.appScreenshots.appId, appId)
        ));
    }
  },

  async update(id: string, data: Partial<masterSchema.NewAppScreenshot>) {
    const [updated] = await masterDb
      .update(masterSchema.appScreenshots)
      .set(data)
      .where(eq(masterSchema.appScreenshots.id, id))
      .returning();
    return updated;
  },
};
