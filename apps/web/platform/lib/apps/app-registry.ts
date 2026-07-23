import {
  ShoppingCart,
  Users,
  ClipboardList,
  CheckSquare,
  BookOpen,
  Headphones,
  Mail,
  Warehouse,
  Calculator,
  Package,
  Globe,
  HardDrive,
  MessageCircle,
  CalendarDays,
  Video,
  Phone,
  ShoppingBag,
  Store,
  Share2,
  Server,
  FolderKanban,
  UserCircle,
  Truck,
  Bot,
  Database,
  type LucideIcon,
} from 'lucide-react';
import type { AppLogo } from '@/components/app-sidebar-layout';

export interface AppAssets {
  /** Lucide icon used as fallback when no image logo exists */
  lucideIcon: LucideIcon;
  /** Short user-friendly label (e.g. "Email" instead of "WeldMail") */
  shortName?: string;
  /** SVG icon path (small, square icon used in onboarding preview etc.) */
  icon?: string;
  /** Image logos for light/dark themes (used in sidebars, app store, etc.) */
  logo?: AppLogo;
  /** CSS class override for the sidebar icon size (visual alignment) */
  sidebarIconClass?: string;
  /** Hide this app from the onboarding app selection (still visible in app store) */
  hideFromOnboarding?: boolean;
}

function makeLogo(appCode: string, opts?: { iconClassName?: string }): AppLogo {
  return {
    iconLight: `/assets/images/${appCode}/logo-light.png`,
    iconDark: `/assets/images/${appCode}/logo-dark.png`,
    textLight: `/assets/images/${appCode}/logo-text-light.png`,
    textDark: `/assets/images/${appCode}/logo-text-dark.png`,
    ...(opts?.iconClassName && { iconClassName: opts.iconClassName }),
  };
}

/**
 * Centralized registry of all first-party app visual assets.
 *
 * Every consumer (sidebar, onboarding, app store, module sidebar, etc.)
 * should import from here instead of maintaining its own icon/logo map.
 */
export const APP_REGISTRY: Record<string, AppAssets> = {
  weldcrm: {
    lucideIcon: Users,
    icon: '/assets/images/weldcrm/icon.svg',
    logo: {
      iconLight: '/assets/images/weldcrm/logo-light.svg',
      iconDark: '/assets/images/weldcrm/logo-dark.svg',
      textLight: '/assets/images/weldcrm/logo-text-light.svg',
      textDark: '/assets/images/weldcrm/logo-text-dark.svg',
    },
  },
  welddesk: {
    lucideIcon: Headphones,
    shortName: 'Customer Support',
    icon: '/assets/images/welddesk/icon.svg',
    logo: makeLogo('welddesk'),
  },
  weldmail: {
    lucideIcon: Mail,
    shortName: 'Email',
    icon: '/assets/images/weldmail/icon.svg',
    logo: makeLogo('weldmail'),
  },
  weldflow: {
    lucideIcon: FolderKanban,
    shortName: 'Project Management',
    icon: '/assets/images/weldflow/icon-projects.svg',
    logo: makeLogo('weldflow'),
    sidebarIconClass: 'h-7 w-7',
  },
  weldconnect: {
    lucideIcon: CheckSquare,
    shortName: 'Automations',
    icon: '/assets/images/weldconnect/icon.svg',
    logo: makeLogo('weldconnect'),
    sidebarIconClass: 'h-[27px] w-[27px]',
    hideFromOnboarding: true,
  },
  weldhost: {
    lucideIcon: Globe,
    shortName: 'Hosting',
    icon: '/assets/images/weldhost/icon.svg',
    logo: makeLogo('weldhost'),
    sidebarIconClass: 'h-[27px] w-[27px]',
  },
  weldchat: {
    lucideIcon: MessageCircle,
    shortName: 'Chat',
    icon: '/assets/images/weldchat/icon.svg',
    logo: makeLogo('weldchat'),
    sidebarIconClass: 'h-6 w-6 object-contain',
  },
  weldcalendar: {
    lucideIcon: CalendarDays,
    shortName: 'Calendar',
    icon: '/assets/images/weldcalendar/icon.svg',
    logo: {
      iconLight: '/assets/images/weldcalendar/logo-light.svg',
      iconDark: '/assets/images/weldcalendar/logo-dark.svg',
      textLight: '/assets/images/weldcalendar/logo-text-light.png',
      textDark: '/assets/images/weldcalendar/logo-text-dark.png',
    },
    sidebarIconClass: 'h-6 w-6 object-contain',
  },
  welddrive: {
    lucideIcon: HardDrive,
    shortName: 'Drive',
    icon: '/assets/images/welddrive/icon.svg',
    logo: makeLogo('welddrive'),
    sidebarIconClass: 'h-6 w-6 object-contain',
  },
  weldmeet: {
    lucideIcon: Video,
    shortName: 'Meetings',
    icon: '/assets/images/weldmeet/icon.svg',
    logo: makeLogo('weldmeet', { iconClassName: 'h-auto w-6 shrink-0' }),
    sidebarIconClass: 'h-auto w-7 object-contain',
  },
  weldcall: {
    lucideIcon: Phone,
    shortName: 'Calls',
    icon: '/assets/images/weldcall/icon.svg',
    logo: {
      iconLight: '/assets/images/weldcall/icon.svg',
      iconDark: '/assets/images/weldcall/icon.svg',
      textLight: '/assets/images/weldcall/logo-text-light.svg',
      textDark: '/assets/images/weldcall/logo-text-dark.svg',
    },
  },
  welddata: {
    lucideIcon: Database,
    shortName: 'Lead Database',
    icon: '/assets/images/welddata/icon.svg',
    logo: {
      iconLight: '/assets/images/welddata/logo-light.svg',
      iconDark: '/assets/images/welddata/logo-dark.svg',
    },
  },
  weldbooks: {
    lucideIcon: Calculator,
  },
  // WeldKnow (workspace wiki / knowledge base). Icon-only logo like welddata —
  // wordmark variants need the brand typeface and can be added later.
  weldknow: {
    lucideIcon: BookOpen,
    shortName: 'Knowledge',
    icon: '/assets/images/weldknow/icon.svg',
    logo: {
      iconLight: '/assets/images/weldknow/logo-light.svg',
      iconDark: '/assets/images/weldknow/logo-dark.svg',
    },
    sidebarIconClass: 'h-6 w-6 object-contain',
  },
  wms: {
    lucideIcon: Warehouse,
  },
  parcel: {
    lucideIcon: Truck,
  },
  weldagent: {
    lucideIcon: Bot,
    icon: '/assets/images/weldagent/icon.svg',
    logo: {
      iconLight: '/assets/images/weldagent/logo-light.svg',
      iconDark: '/assets/images/weldagent/logo-dark.svg',
      textLight: '/assets/images/weldagent/logo-text-light.svg',
      textDark: '/assets/images/weldagent/logo-text-dark.svg',
      textClassName: 'h-auto w-[170px]',
    },
  },
  weldsuite: {
    lucideIcon: Bot,
    icon: '/assets/images/weldsuite/icon.svg',
    logo: makeLogo('weldsuite'),
  },
  // Analytics has no standalone brand — it reuses the WeldSuite logo icon.
  analytics: {
    lucideIcon: Bot,
    icon: '/assets/images/weldsuite/icon.svg',
    logo: makeLogo('weldsuite'),
  },
  social: {
    lucideIcon: Share2,
    shortName: 'Social',
    icon: '/assets/images/social/icon.svg',
    logo: {
      iconLight: '/assets/images/social/logo-light.svg',
      iconDark: '/assets/images/social/logo-dark.svg',
    },
    sidebarIconClass: 'h-6 w-6 object-contain',
  },
};

/**
 * Legacy/short app codes (as returned by the onboarding catalog and some older
 * backends) mapped to their canonical `weld*` registry key. The registry is
 * keyed by the new module names, but callers may still pass the old codes —
 * without this bridge, lookups silently miss and brand logos disappear (e.g.
 * the onboarding app picker renders generic Lucide icons instead of logos).
 */
const LEGACY_CODE_ALIASES: Record<string, string> = {
  crm: 'weldcrm',
  projects: 'weldflow',
  task: 'weldconnect',
  tasks: 'weldconnect',
  connect: 'weldconnect',
  helpdesk: 'welddesk',
  desk: 'welddesk',
  mail: 'weldmail',
  host: 'weldhost',
  stash: 'wms',
  accounting: 'weldbooks',
  books: 'weldbooks',
  meet: 'weldmeet',
  chat: 'weldchat',
  calendar: 'weldcalendar',
  drive: 'welddrive',
  call: 'weldcall',
  data: 'welddata',
  agent: 'weldagent',
  knowledge: 'weldknow',
  know: 'weldknow',
};

/** Resolve a possibly-legacy app code to its canonical registry key. */
function resolveAppCode(code: string): string {
  if (!code) return code;
  if (APP_REGISTRY[code]) return code;
  const lower = code.toLowerCase();
  if (APP_REGISTRY[lower]) return lower;
  return LEGACY_CODE_ALIASES[lower] ?? lower;
}

/** Look up the registry assets for a code, resolving legacy aliases first. */
function lookupAssets(code: string): AppAssets | undefined {
  return APP_REGISTRY[resolveAppCode(code)];
}

/** Get the app logo image path for the given theme, or undefined if no logo exists. */
export function getAppLogo(code: string, theme: 'light' | 'dark'): string | undefined {
  const assets = lookupAssets(code);
  if (!assets?.logo) return undefined;
  return theme === 'dark' ? assets.logo.iconDark : assets.logo.iconLight;
}

/** Get the app text logo image path for the given theme, or undefined. */
function getAppTextLogo(code: string, theme: 'light' | 'dark'): string | undefined {
  const assets = lookupAssets(code);
  if (!assets?.logo) return undefined;
  return theme === 'dark' ? assets.logo.textDark : assets.logo.textLight;
}

/** Get the SVG icon path (small square icon), or undefined. */
export function getAppIcon(code: string): string | undefined {
  return lookupAssets(code)?.icon;
}

/** Get the Lucide fallback icon component, or Package as default. */
export function getAppLucideIcon(code: string): LucideIcon {
  return lookupAssets(code)?.lucideIcon ?? Package;
}

/** Get the AppLogo object for module sidebar configs, or undefined. */
export function getAppLogoConfig(code: string): AppLogo | undefined {
  return lookupAssets(code)?.logo;
}

/** Get the sidebar icon size class override, or undefined. */
export function getAppSidebarIconClass(code: string): string | undefined {
  return lookupAssets(code)?.sidebarIconClass;
}

/** Get the short user-friendly name, or fall back to the provided default. */
export function getAppShortName(code: string, fallback: string): string {
  return lookupAssets(code)?.shortName ?? fallback;
}

/** Check if an app should be hidden from the onboarding flow. */
export function isHiddenFromOnboarding(code: string): boolean {
  return lookupAssets(code)?.hideFromOnboarding === true;
}
