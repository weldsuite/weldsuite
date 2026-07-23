// App catalog - now fetches from database
// Apps are stored in the master database's app_catalog table

import { masterDb } from '@/lib/db/master';
import { appCatalog, appScreenshots, APP_CATEGORIES } from '@/lib/db/schema/app-catalog';
import { eq, and } from 'drizzle-orm';

type AppCategory = (typeof APP_CATEGORIES)[number];

export interface AppDefinition {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview?: string | null;
  features?: string[];
  howItWorks?: { title: string; description: string }[];
  version?: string;
  provider?: string | null;
}

interface AppScreenshotData {
  id: string;
  url: string;
  fileName: string;
  caption?: string | null;
  altText?: string | null;
}

interface AppWithContent extends AppDefinition {
  screenshots: AppScreenshotData[];
}

// Fallback static catalog for when database is unavailable
const FALLBACK_CATALOG: Record<string, AppDefinition> = {
  weldcrm: {
    code: 'weldcrm',
    name: 'WeldCRM',
    description: 'Manage leads, contacts, and sales pipelines',
    icon: 'Users',
    category: 'Sales & Marketing',
    path: '/weldcrm',
  },
  weldflow: {
    code: 'weldflow',
    name: 'WeldFlow',
    description:
      'Project management and collaboration tools for teams, tasks, timelines, and deliverables',
    icon: 'ClipboardList',
    category: 'Productivity',
    path: '/weldflow',
  },
  weldconnect: {
    code: 'weldconnect',
    name: 'WeldConnect',
    description:
      'Personal task management for tracking to-dos, deadlines, and daily productivity',
    icon: 'CheckSquare',
    category: 'Productivity',
    path: '/weldconnect',
  },
  welddesk: {
    code: 'welddesk',
    name: 'WeldDesk',
    description:
      'Customer support ticketing system for managing customer inquiries and support requests',
    icon: 'Headphones',
    category: 'Customer Support',
    path: '/welddesk',
  },
  weldmail: {
    code: 'weldmail',
    name: 'WeldMail',
    description:
      'Email management and communication platform for team collaboration and customer outreach',
    icon: 'Mail',
    category: 'Communication',
    path: '/weldmail',
  },
  weldhost: {
    code: 'weldhost',
    name: 'WeldHost',
    description:
      'Domain management and hosting services for websites and online presence',
    icon: 'Globe',
    category: 'Infrastructure',
    path: '/weldhost',
  },
  welddrive: {
    code: 'welddrive',
    name: 'WeldDrive',
    description:
      'Central file hub for uploading, organizing, and browsing all files across the platform',
    icon: 'HardDrive',
    category: 'Productivity',
    path: '/welddrive',
  },
  weldbooks: {
    code: 'weldbooks',
    name: 'WeldBooks',
    description:
      'Full accounting with multi-entity support — invoices, bills, banking, journal entries, VAT returns, and per-jurisdiction compliance (NL BTW/Digipoort today)',
    icon: 'Calculator',
    category: 'Finance',
    path: '/weldbooks',
  },
  weldcall: {
    code: 'weldcall',
    name: 'WeldCall',
    description:
      'Business phone system for inbound and outbound calls, IVR routing, call recording, and CRM-linked call history',
    icon: 'Phone',
    category: 'Communication',
    path: '/weldcall',
  },
  welddata: {
    code: 'welddata',
    name: 'WeldData',
    description:
      'Find B2B leads from a built-in database, save people and companies to lists, and convert them into WeldCRM records',
    icon: 'Database',
    category: 'Sales & Marketing',
    path: '/welddata',
  },
  weldknow: {
    code: 'weldknow',
    name: 'WeldKnow',
    description:
      'Workspace knowledge base and wiki — nested pages with rich-text editing, version history, favorites, and search',
    icon: 'BookOpen',
    category: 'Productivity',
    path: '/weldknow',
  },
  social: {
    code: 'social',
    name: 'WeldSocial',
    description:
      'Schedule and publish social media posts across all your channels from one place — a content calendar, queue, approvals, and analytics powered by PostPeer',
    icon: 'Share2',
    category: 'Sales & Marketing',
    path: '/social',
  },
};

/**
 * Get all active apps from the database
 */
async function getAppCatalog(): Promise<AppDefinition[]> {
  try {
    const apps = await masterDb
      .select()
      .from(appCatalog)
      .where(and(eq(appCatalog.isActive, true), eq(appCatalog.isPublished, true)));

    if (apps.length === 0) {
      // Fallback to static catalog if database is empty
      return Object.values(FALLBACK_CATALOG);
    }

    return apps.map((app) => ({
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      path: app.path,
      overview: app.overview,
      features: app.features as string[] | undefined,
      howItWorks: app.howItWorks as { title: string; description: string }[] | undefined,
      version: app.version || '1.0.0',
      provider: app.provider,
    }));
  } catch (error) {
    console.error('Error fetching app catalog from database:', error);
    // Fallback to static catalog on error
    return Object.values(FALLBACK_CATALOG);
  }
}

/**
 * Get a single app by code from the database
 */
async function getAppByCode(code: string): Promise<AppDefinition | null> {
  try {
    const apps = await masterDb
      .select()
      .from(appCatalog)
      .where(and(eq(appCatalog.code, code), eq(appCatalog.isActive, true)));

    if (apps.length === 0) {
      // Try fallback catalog
      return FALLBACK_CATALOG[code] || null;
    }

    const app = apps[0];
    return {
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      path: app.path,
      overview: app.overview,
      features: app.features as string[] | undefined,
      howItWorks: app.howItWorks as { title: string; description: string }[] | undefined,
      version: app.version || '1.0.0',
      provider: app.provider,
    };
  } catch (error) {
    console.error('Error fetching app from database:', error);
    return FALLBACK_CATALOG[code] || null;
  }
}

/**
 * Get app with screenshots
 */
async function getAppWithScreenshots(code: string): Promise<AppWithContent | null> {
  try {
    const apps = await masterDb
      .select()
      .from(appCatalog)
      .where(and(eq(appCatalog.code, code), eq(appCatalog.isActive, true)));

    if (apps.length === 0) {
      // Try fallback catalog
      const fallback = FALLBACK_CATALOG[code];
      if (fallback) {
        return { ...fallback, screenshots: [] };
      }
      return null;
    }

    const app = apps[0];

    // Get screenshots
    const screenshotRows = await masterDb
      .select()
      .from(appScreenshots)
      .where(eq(appScreenshots.appId, app.id));

    const screenshots: AppScreenshotData[] = screenshotRows.map((s) => ({
      id: s.id,
      url: s.url,
      fileName: s.fileName,
      caption: s.caption,
      altText: s.altText,
    }));

    return {
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      path: app.path,
      overview: app.overview,
      features: app.features as string[] | undefined,
      howItWorks: app.howItWorks as { title: string; description: string }[] | undefined,
      version: app.version || '1.0.0',
      provider: app.provider,
      screenshots,
    };
  } catch (error) {
    console.error('Error fetching app with screenshots:', error);
    const fallback = FALLBACK_CATALOG[code];
    if (fallback) {
      return { ...fallback, screenshots: [] };
    }
    return null;
  }
}

/**
 * Get apps by category
 */
async function getAppsByCategory(category: AppCategory): Promise<AppDefinition[]> {
  const apps = await getAppCatalog();
  return apps.filter((app) => app.category === category);
}

/**
 * Get all unique categories from available apps
 */
export async function getCategories(): Promise<string[]> {
  const apps = await getAppCatalog();
  return [...new Set(apps.map((app) => app.category))];
}

// Legacy exports for backward compatibility
// These will use fallback data if database is unavailable
export const APP_CATALOG = FALLBACK_CATALOG;
export const AVAILABLE_APPS = Object.values(FALLBACK_CATALOG);

/**
 * Validate app code (checks both database and fallback)
 */
async function isValidAppCode(code: string): Promise<boolean> {
  const app = await getAppByCode(code);
  return app !== null;
}
