/**
 * Setup Clerk Permissions & Roles
 *
 * This script creates features, permissions, and custom roles in Clerk
 * using the Clerk Backend API. Run this once to initialize the permission
 * model in your Clerk organization.
 *
 * Usage:
 *   npx tsx scripts/setup-clerk-permissions.ts
 *
 * Required env vars:
 *   CLERK_SECRET_KEY - Your Clerk secret key
 */

import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

// ============================================================================
// Permission Definitions
// ============================================================================

interface FeaturePermissions {
  feature: string;
  description: string;
  permissions: string[];
}

const CLERK_FEATURES: FeaturePermissions[] = [
  // Settings
  {
    feature: 'settings',
    description: 'General workspace settings',
    permissions: ['org:settings:read', 'org:settings:update'],
  },
  {
    feature: 'team',
    description: 'Team member management',
    permissions: ['org:team:read', 'org:team:create', 'org:team:update', 'org:team:delete'],
  },
  {
    feature: 'roles',
    description: 'Roles & permissions management',
    permissions: ['org:roles:read', 'org:roles:create', 'org:roles:update', 'org:roles:delete'],
  },
  {
    feature: 'apikeys',
    description: 'API key management',
    permissions: ['org:apikeys:read', 'org:apikeys:create', 'org:apikeys:delete'],
  },
  {
    feature: 'billing',
    description: 'Billing & subscriptions',
    permissions: ['org:billing:read', 'org:billing:manage'],
  },

  // CRM
  {
    feature: 'leads',
    description: 'CRM leads',
    permissions: ['org:leads:read', 'org:leads:create', 'org:leads:update', 'org:leads:delete'],
  },
  {
    feature: 'contacts',
    description: 'CRM contacts',
    permissions: ['org:contacts:read', 'org:contacts:create', 'org:contacts:update', 'org:contacts:delete'],
  },
  {
    feature: 'opportunities',
    description: 'CRM opportunities',
    permissions: ['org:opportunities:read', 'org:opportunities:create', 'org:opportunities:update', 'org:opportunities:delete'],
  },
  {
    feature: 'activities',
    description: 'CRM activities',
    permissions: ['org:activities:read', 'org:activities:create', 'org:activities:update', 'org:activities:delete'],
  },
  {
    feature: 'pipelines',
    description: 'CRM pipelines',
    permissions: ['org:pipelines:read', 'org:pipelines:create', 'org:pipelines:update', 'org:pipelines:delete', 'org:pipelines:manage'],
  },
  {
    feature: 'quotes',
    description: 'CRM quotes',
    permissions: ['org:quotes:read', 'org:quotes:create', 'org:quotes:update', 'org:quotes:delete'],
  },

  // Consolidated features (shared across apps)
  {
    feature: 'products',
    description: 'Products (WMS + Commerce)',
    permissions: ['org:products:read', 'org:products:create', 'org:products:update', 'org:products:delete'],
  },
  {
    feature: 'orders',
    description: 'Orders (WMS + Commerce + Parcel)',
    permissions: ['org:orders:read', 'org:orders:create', 'org:orders:update', 'org:orders:delete'],
  },
  {
    feature: 'customers',
    description: 'Customers (CRM + Commerce + Accounting)',
    permissions: ['org:customers:read', 'org:customers:create', 'org:customers:update', 'org:customers:delete'],
  },

  // WMS-specific
  {
    feature: 'inventory',
    description: 'WMS inventory management',
    permissions: ['org:inventory:read', 'org:inventory:update', 'org:inventory:manage'],
  },
  {
    feature: 'picklists',
    description: 'WMS pick lists',
    permissions: ['org:picklists:read', 'org:picklists:create', 'org:picklists:update', 'org:picklists:delete'],
  },
  {
    feature: 'locations',
    description: 'WMS warehouse locations',
    permissions: ['org:locations:read', 'org:locations:create', 'org:locations:update', 'org:locations:delete'],
  },
  {
    feature: 'warehouses',
    description: 'WMS warehouses',
    permissions: ['org:warehouses:read', 'org:warehouses:create', 'org:warehouses:update', 'org:warehouses:delete', 'org:warehouses:manage'],
  },
  {
    feature: 'suppliers',
    description: 'WMS suppliers',
    permissions: ['org:suppliers:read', 'org:suppliers:create', 'org:suppliers:update', 'org:suppliers:delete'],
  },

  // Commerce-specific
  {
    feature: 'discounts',
    description: 'Commerce discounts',
    permissions: ['org:discounts:read', 'org:discounts:create', 'org:discounts:update', 'org:discounts:delete'],
  },
  {
    feature: 'categories',
    description: 'Commerce categories',
    permissions: ['org:categories:read', 'org:categories:create', 'org:categories:update', 'org:categories:delete'],
  },
  {
    feature: 'websites',
    description: 'Commerce websites',
    permissions: ['org:websites:read', 'org:websites:create', 'org:websites:update', 'org:websites:delete', 'org:websites:manage'],
  },

  // Accounting
  {
    feature: 'invoices',
    description: 'Accounting invoices',
    permissions: ['org:invoices:read', 'org:invoices:create', 'org:invoices:update', 'org:invoices:delete'],
  },
  {
    feature: 'bills',
    description: 'Accounting bills',
    permissions: ['org:bills:read', 'org:bills:create', 'org:bills:update', 'org:bills:delete'],
  },
  {
    feature: 'journal',
    description: 'Accounting journal entries',
    permissions: ['org:journal:read', 'org:journal:create', 'org:journal:update', 'org:journal:delete', 'org:journal:manage'],
  },
  {
    feature: 'accounts',
    description: 'Chart of accounts',
    permissions: ['org:accounts:read', 'org:accounts:create', 'org:accounts:update', 'org:accounts:delete', 'org:accounts:manage'],
  },
  {
    feature: 'banking',
    description: 'Banking transactions',
    permissions: ['org:banking:read', 'org:banking:create', 'org:banking:update', 'org:banking:manage'],
  },
  {
    feature: 'vendors',
    description: 'Accounting vendors',
    permissions: ['org:vendors:read', 'org:vendors:create', 'org:vendors:update', 'org:vendors:delete'],
  },
  {
    feature: 'reports',
    description: 'Financial reports',
    permissions: ['org:reports:read', 'org:reports:manage'],
  },

  // Helpdesk
  {
    feature: 'tickets',
    description: 'Helpdesk tickets',
    permissions: ['org:tickets:read', 'org:tickets:create', 'org:tickets:update', 'org:tickets:delete'],
  },
  {
    feature: 'conversations',
    description: 'Helpdesk conversations',
    permissions: ['org:conversations:read', 'org:conversations:create', 'org:conversations:update', 'org:conversations:delete'],
  },
  {
    feature: 'articles',
    description: 'Knowledge base articles',
    permissions: ['org:articles:read', 'org:articles:create', 'org:articles:update', 'org:articles:delete'],
  },
  {
    feature: 'agents',
    description: 'Helpdesk agents',
    permissions: ['org:agents:read', 'org:agents:create', 'org:agents:update', 'org:agents:delete', 'org:agents:manage'],
  },
  {
    feature: 'departments',
    description: 'Helpdesk departments',
    permissions: ['org:departments:read', 'org:departments:create', 'org:departments:update', 'org:departments:delete', 'org:departments:manage'],
  },
  {
    feature: 'slas',
    description: 'Service level agreements',
    permissions: ['org:slas:read', 'org:slas:create', 'org:slas:update', 'org:slas:delete', 'org:slas:manage'],
  },
  {
    feature: 'helpdesk_settings',
    description: 'Helpdesk configuration',
    permissions: ['org:helpdesk_settings:read', 'org:helpdesk_settings:update', 'org:helpdesk_settings:manage'],
  },

  // Parcel
  {
    feature: 'parcels',
    description: 'Parcel tracking',
    permissions: ['org:parcels:read', 'org:parcels:create', 'org:parcels:update', 'org:parcels:delete'],
  },
  {
    feature: 'carriers',
    description: 'Shipping carriers',
    permissions: ['org:carriers:read', 'org:carriers:create', 'org:carriers:update', 'org:carriers:delete', 'org:carriers:manage'],
  },
  {
    feature: 'boxes',
    description: 'Box templates',
    permissions: ['org:boxes:read', 'org:boxes:create', 'org:boxes:update', 'org:boxes:delete'],
  },
  {
    feature: 'returns',
    description: 'Parcel returns',
    permissions: ['org:returns:read', 'org:returns:create', 'org:returns:update', 'org:returns:delete'],
  },
  {
    feature: 'pickups',
    description: 'Parcel pickups',
    permissions: ['org:pickups:read', 'org:pickups:create', 'org:pickups:update', 'org:pickups:delete'],
  },
  {
    feature: 'webhooks',
    description: 'Parcel webhooks',
    permissions: ['org:webhooks:read', 'org:webhooks:create', 'org:webhooks:update', 'org:webhooks:delete', 'org:webhooks:manage'],
  },

  // Projects
  {
    feature: 'projects',
    description: 'Project management',
    permissions: ['org:projects:read', 'org:projects:create', 'org:projects:update', 'org:projects:delete'],
  },
  {
    feature: 'tasks',
    description: 'Project tasks',
    permissions: ['org:tasks:read', 'org:tasks:create', 'org:tasks:update', 'org:tasks:delete'],
  },
  {
    feature: 'milestones',
    description: 'Project milestones',
    permissions: ['org:milestones:read', 'org:milestones:create', 'org:milestones:update', 'org:milestones:delete'],
  },
  {
    feature: 'time',
    description: 'Time entries',
    permissions: ['org:time:read', 'org:time:create', 'org:time:update', 'org:time:delete'],
  },
  {
    feature: 'files',
    description: 'Project files',
    permissions: ['org:files:read', 'org:files:create', 'org:files:update', 'org:files:delete'],
  },

  // Mail
  {
    feature: 'mail_accounts',
    description: 'Mail accounts',
    permissions: ['org:mail_accounts:read', 'org:mail_accounts:create', 'org:mail_accounts:update', 'org:mail_accounts:delete', 'org:mail_accounts:manage'],
  },
  {
    feature: 'messages',
    description: 'Email messages',
    permissions: ['org:messages:read', 'org:messages:create', 'org:messages:update', 'org:messages:delete'],
  },
  {
    feature: 'templates',
    description: 'Email templates',
    permissions: ['org:templates:read', 'org:templates:create', 'org:templates:update', 'org:templates:delete'],
  },
  {
    feature: 'campaigns',
    description: 'Email campaigns',
    permissions: ['org:campaigns:read', 'org:campaigns:create', 'org:campaigns:update', 'org:campaigns:delete'],
  },

  // Host
  {
    feature: 'domains',
    description: 'Domain management',
    permissions: ['org:domains:read', 'org:domains:create', 'org:domains:update', 'org:domains:delete'],
  },
  {
    feature: 'dns',
    description: 'DNS records',
    permissions: ['org:dns:read', 'org:dns:create', 'org:dns:update', 'org:dns:delete'],
  },
  {
    feature: 'email_forwarding',
    description: 'Email forwarding rules',
    permissions: ['org:email_forwarding:read', 'org:email_forwarding:create', 'org:email_forwarding:update', 'org:email_forwarding:delete'],
  },
];

// ============================================================================
// Role Definitions
// ============================================================================

// Collect all permissions
const ALL_PERMISSIONS = CLERK_FEATURES.flatMap(f => f.permissions);

// Admin gets everything except billing:manage
const ADMIN_PERMISSIONS = ALL_PERMISSIONS.filter(p => p !== 'org:billing:manage');

// Member gets standard CRUD (read/create/update) plus settings:read and team:read
const MEMBER_PERMISSIONS = CLERK_FEATURES.flatMap(f => {
  return f.permissions.filter(p => {
    const action = p.split(':').pop();
    // Members don't get delete/manage on most features
    if (action === 'manage') return false;
    // Members don't get delete on most features (except messages)
    if (action === 'delete' && !['org:messages:delete'].includes(p)) return false;
    // Members don't get billing write access
    if (p === 'org:billing:manage') return false;
    // Members don't get roles write access
    if (f.feature === 'roles' && action !== 'read') return false;
    // Members don't get apikeys delete
    if (f.feature === 'apikeys' && action === 'delete') return false;
    return true;
  });
});

// Viewer gets read-only
const VIEWER_PERMISSIONS = ALL_PERMISSIONS.filter(p => p.endsWith(':read'));

interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
}

const CUSTOM_ROLES: RoleDefinition[] = [
  {
    key: 'org:admin_role',
    name: 'Admin',
    description: 'Can manage team members, roles, and most settings (except billing)',
    permissions: ADMIN_PERMISSIONS,
    isSystem: true,
  },
  {
    key: 'org:member_role',
    name: 'Member',
    description: 'Standard access to assigned apps and features',
    permissions: MEMBER_PERMISSIONS,
    isSystem: true,
  },
  {
    key: 'org:viewer_role',
    name: 'Viewer',
    description: 'Read-only access to workspace data',
    permissions: VIEWER_PERMISSIONS,
    isSystem: true,
  },
];

// ============================================================================
// Setup Functions
// ============================================================================

async function createPermissions() {
  console.log('\n--- Creating Permissions ---\n');

  for (const feature of CLERK_FEATURES) {
    for (const permission of feature.permissions) {
      try {
        await clerkClient.organizations.createOrganizationPermission({
          name: permission,
          key: permission,
          description: `${feature.description}: ${permission.split(':').pop()}`,
        });
        console.log(`  Created permission: ${permission}`);
      } catch (error: any) {
        if (error?.status === 422 || error?.errors?.[0]?.code === 'duplicate_record') {
          console.log(`  Skipped (exists): ${permission}`);
        } else {
          console.error(`  Failed to create permission ${permission}:`, error?.message || error);
        }
      }
    }
  }

  console.log(`\nTotal permissions: ${ALL_PERMISSIONS.length}`);
}

async function createRoles() {
  console.log('\n--- Creating Custom Roles ---\n');
  console.log('Note: org:admin is a built-in Clerk role with all permissions.');

  for (const role of CUSTOM_ROLES) {
    try {
      await clerkClient.organizations.createOrganizationRole({
        name: role.name,
        key: role.key,
        description: role.description,
        permissions: role.permissions,
      });
      console.log(`  Created role: ${role.key} (${role.name}) with ${role.permissions.length} permissions`);
    } catch (error: any) {
      if (error?.status === 422 || error?.errors?.[0]?.code === 'duplicate_record') {
        console.log(`  Skipped (exists): ${role.key}`);
        // Try to update permissions for existing role
        try {
          await clerkClient.organizations.updateOrganizationRole(role.key, {
            permissions: role.permissions,
          });
          console.log(`  Updated permissions for: ${role.key}`);
        } catch (updateError: any) {
          console.warn(`  Could not update ${role.key}:`, updateError?.message || updateError);
        }
      } else {
        console.error(`  Failed to create role ${role.key}:`, error?.message || error);
      }
    }
  }
}

async function main() {
  console.log('========================================');
  console.log('  Clerk Permissions & Roles Setup');
  console.log('========================================');

  if (!process.env.CLERK_SECRET_KEY) {
    console.error('Error: CLERK_SECRET_KEY environment variable is required');
    process.exit(1);
  }

  await createPermissions();
  await createRoles();

  console.log('\n========================================');
  console.log('  Setup Complete!');
  console.log('========================================');
  console.log('\nNext steps:');
  console.log('1. Verify permissions in Clerk Dashboard > Organizations > Permissions');
  console.log('2. Verify roles in Clerk Dashboard > Organizations > Roles');
  console.log('3. Run the migration script: npx tsx scripts/migrate-rbac-to-clerk.ts');
}

main().catch(console.error);
