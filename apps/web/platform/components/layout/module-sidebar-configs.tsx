import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Inbox,
  BarChart3,
  Users,
  BookOpen,
  Globe,
  Briefcase,
  FolderOpen,
  Settings,
  Server,
  Plus,
  SquareArrowOutUpRight,
  Zap,
  Workflow,
  History,
  SquareCheck,
  Contact,
  User,
  Phone,
  Video,
  StickyNote,
  Headphones,
  MessagesSquare,
  Star,
  Bot,
  CalendarDays,
  Calendar,
  HardDrive,
  Clock,
  Trash2,
  CloudUpload,
  Share2,
  Mail,
  Calculator,
  FileText,
  Receipt,
  Building,
  Building2,
  Landmark,
  CreditCard,
  FileSearch,
  RefreshCw,
  ArrowLeftRight,
  LayoutDashboard,
  Wand2,
  Truck,
  Sparkles,
  Database,
  Search,
  Megaphone,
  Link2,
  CircleCheck,
  Package,
  FolderTree,
  ShoppingCart,
  Warehouse,
  Boxes,
  ClipboardList,
  PackageCheck,
  KeyRound,
  LockKeyhole,
  Vault,
  HeartPulse,
  UsersRound,
  CalendarCheck,
  Plane,
  ClipboardCheck,
  AppWindow,
  UserRound,
  Percent,
  ShieldCheck,
  Radar,
  CalendarClock,
  Banknote,
  Wallet,
  FileSpreadsheet,
  CalendarRange,
  Layers,
  ChevronLeft,
} from 'lucide-react';
import type { MenuGroupProps, AppLogo } from '@/components/app-sidebar-layout';
import type { TranslationsType } from '@/lib/i18n/types';
import { getAppLogoConfig } from '@/lib/apps/app-registry';


export interface ModuleSidebarConfig {
  appName: string;
  appIcon: LucideIcon | ComponentType<{ className?: string }>;
  appLogo?: AppLogo;
  getMenuItems: (t: TranslationsType) => MenuGroupProps[];
}

export const MODULE_CONFIGS: Record<string, ModuleSidebarConfig> = {
  weldcrm: {
    appName: 'WeldCRM',
    appIcon: Users,
    appLogo: getAppLogoConfig('weldcrm'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          // No permission: "My Tasks" shows the current user's own tasks — always visible
          { title: t.navigation.moduleSidebar.weldcrm.myTasks, href: '/weldcrm', icon: SquareCheck },
          // Companies + People are the new identity surfaces (Companies/People refactor).
          // Legacy /weldcrm/customers and /weldcrm/contacts URLs redirect here.
          // Permission keys still gate on customers/contacts during the transition;
          // they'll be renamed in Phase 10.
          { title: t.navigation.moduleSidebar.weldcrm.companies, href: '/weldcrm/companies', icon: Building, permission: 'customers:read' },
          { title: t.navigation.moduleSidebar.weldcrm.people, href: '/weldcrm/people', icon: User, permission: 'contacts:read' },
          // Notes are CRM-scoped notes attached to contacts/customers — gated on contacts:read
          // (no dedicated `notes` permission object; notes are read via the contacts API surface)
          { title: t.navigation.moduleSidebar.weldcrm.notes, href: '/weldcrm/notes', icon: StickyNote, permission: 'contacts:read' },
          // Sequences are drip-campaign sequences targeting contacts — backend gates them on contacts:*
          { title: t.navigation.moduleSidebar.weldcrm.sequences, href: '/weldcrm/sequences', icon: Workflow, permission: 'contacts:read' },
        ],
      },
    ],
  },
  weldcommerce: {
    appName: 'WeldCommerce',
    appIcon: ShoppingCart,
    appLogo: getAppLogoConfig('weldcommerce'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldcommerce.overview, href: '/weldcommerce', icon: LayoutDashboard },
          { title: t.navigation.moduleSidebar.weldcommerce.products, href: '/weldcommerce/products', icon: Package, permission: 'products:read' },
          { title: t.navigation.moduleSidebar.weldcommerce.categories, href: '/weldcommerce/categories', icon: FolderTree, permission: 'categories:read' },
          { title: t.navigation.moduleSidebar.weldcommerce.orders, href: '/weldcommerce/orders', icon: ShoppingCart, permission: 'orders:read' },
          { title: t.navigation.moduleSidebar.weldcommerce.customers, href: '/weldcommerce/customers', icon: Building, permission: 'companies:read' },
          { title: t.navigation.moduleSidebar.weldcommerce.portal, href: '/weldcommerce/settings', icon: Globe, permission: 'companies:read' },
        ],
      },
    ],
  },
  weldads: {
    appName: 'WeldAds',
    appIcon: Megaphone,
    appLogo: getAppLogoConfig('weldads'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldads.overview, href: '/weldads', icon: LayoutDashboard },
          { title: t.navigation.moduleSidebar.weldads.campaigns, href: '/weldads/campaigns', icon: Megaphone, permission: 'ad_campaigns:read' },
          { title: t.navigation.moduleSidebar.weldads.accounts, href: '/weldads/accounts', icon: Link2, permission: 'ad_accounts:read' },
        ],
      },
    ],
  },
  weldstash: {
    appName: 'WeldStash',
    appIcon: Warehouse,
    appLogo: getAppLogoConfig('weldstash'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldstash.overview, href: '/weldstash', icon: LayoutDashboard },
          // `products` is the same table WeldCommerce reads — see
          // app/weldstash/products/config/product-grid-config.ts.
          { title: t.navigation.moduleSidebar.weldstash.products, href: '/weldstash/products', icon: Package, permission: 'products:read' },
          { title: t.navigation.moduleSidebar.weldstash.suppliers, href: '/weldstash/suppliers', icon: Truck, permission: 'suppliers:read' },
          { title: t.navigation.moduleSidebar.weldstash.warehouses, href: '/weldstash/warehouses', icon: Warehouse, permission: 'warehouses:read' },
          { title: t.navigation.moduleSidebar.weldstash.stock, href: '/weldstash/stock', icon: Boxes, permission: 'inventory:read' },
          { title: t.navigation.moduleSidebar.weldstash.pickLists, href: '/weldstash/pick-lists', icon: ClipboardList, permission: 'picklists:read' },
          { title: t.navigation.moduleSidebar.weldstash.packing, href: '/weldstash/packing', icon: PackageCheck, permission: 'picklists:read' },
        ],
      },
    ],
  },
  welddata: {
    appName: 'WeldData',
    appIcon: Database,
    appLogo: getAppLogoConfig('welddata'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.welddata.findLeads, href: '/welddata', icon: Search, permission: 'prospects:read' },
        ],
      },
    ],
  },
  weldpass: {
    appName: 'WeldPass',
    appIcon: KeyRound,
    appLogo: getAppLogoConfig('weldpass'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldpass.passwords, href: '/weldpass/passwords', icon: LockKeyhole, permission: 'passwords:use' },
          { title: t.navigation.moduleSidebar.weldpass.vaults, href: '/weldpass/passwords/vaults', icon: Vault, permission: 'passwords:use' },
          { title: t.navigation.moduleSidebar.weldpass.passwordHealth, href: '/weldpass/passwords/health', icon: HeartPulse, permission: 'passwords:use' },
          { title: t.navigation.moduleSidebar.weldpass.projects, href: '/weldpass', icon: KeyRound, permission: 'secrets:read' },
        ],
      },
    ],
  },
  weldhr: {
    appName: 'WeldHR',
    appIcon: UsersRound,
    appLogo: getAppLogoConfig('weldhr'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.weldhr.groups.people,
        items: [
          { title: t.navigation.moduleSidebar.weldhr.myHr, href: '/weldhr/me', icon: UserRound, permission: 'employees:self' },
          { title: t.navigation.moduleSidebar.weldhr.dashboard, href: '/weldhr', icon: LayoutDashboard },
          { title: t.navigation.moduleSidebar.weldhr.employees, href: '/weldhr/employees', icon: User, permission: 'employees:read' },
        ],
      },
      {
        group: t.navigation.moduleSidebar.weldhr.groups.time,
        items: [
          { title: t.navigation.moduleSidebar.weldhr.attendance, href: '/weldhr/attendance', icon: CalendarCheck, permission: 'attendance:read' },
          // No permission: employees report sick here, and the page shows HR's lists only with absences:read.
          { title: t.navigation.moduleSidebar.weldhr.absenteeism, href: '/weldhr/absenteeism', icon: HeartPulse },
          { title: t.navigation.moduleSidebar.weldhr.leave, href: '/weldhr/leave', icon: Plane, permission: 'leave:read' },
        ],
      },
      {
        group: t.navigation.moduleSidebar.weldhr.groups.expenses,
        items: [
          { title: t.navigation.moduleSidebar.weldhr.declarations, href: '/weldhr/declarations', icon: Receipt, permission: 'declarations:read' },
        ],
      },
      {
        // Hidden until the weldhr-payroll flag is on (see useWeldhrSidebarItems).
        group: t.navigation.moduleSidebar.weldhr.groups.payroll,
        items: [
          { title: t.navigation.moduleSidebar.weldhr.payroll, href: '/weldhr/payroll', icon: Banknote, permission: 'payroll:read' },
          { title: t.navigation.moduleSidebar.weldhr.payRuns, href: '/weldhr/payroll/runs', icon: CalendarClock, permission: 'payroll:read' },
          { title: t.navigation.moduleSidebar.weldhr.payrollEmployees, href: '/weldhr/payroll/employees', icon: Users, permission: 'payroll:read' },
          { title: t.navigation.moduleSidebar.weldhr.filings, href: '/weldhr/payroll/filings', icon: FileSpreadsheet, permission: 'payroll:read' },
          { title: t.navigation.moduleSidebar.weldhr.payrollSettings, href: '/weldhr/payroll/settings', icon: Settings, permission: 'payroll:manage' },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.settings,
        items: [
          { title: t.navigation.moduleSidebar.weldhr.portal, href: '/weldhr/portal', icon: AppWindow, permission: 'employees:manage' },
        ],
      },
    ],
  },
  weldhost: {
    appName: 'WeldHost',
    appIcon: Server,
    appLogo: getAppLogoConfig('weldhost'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.domains,
        items: [
          { title: t.navigation.moduleSidebar.weldhost.myDomains, href: '/weldhost/domains', icon: Globe },
          { title: t.navigation.moduleSidebar.weldhost.registerDomain, href: '/weldhost/domains/register', icon: Plus },
          { title: t.navigation.moduleSidebar.weldhost.externalDomains, href: '/weldhost/domains/external', icon: SquareArrowOutUpRight },
        ],
      },
    ],
  },
  weldconnect: {
    appName: 'WeldConnect',
    appIcon: Zap,
    appLogo: getAppLogoConfig('weldconnect'),
    getMenuItems: () => [],
  },
  welddesk: {
    appName: 'WeldDesk',
    appIcon: Headphones,
    appLogo: getAppLogoConfig('welddesk'),
    getMenuItems: (t) => [
      {
        group: '',
        items: [
          { title: t.navigation.moduleSidebar.welddesk.inbox, href: '/welddesk/inbox', icon: Inbox },
          { title: t.navigation.moduleSidebar.welddesk.phone, href: '/welddesk/inbox/phone', icon: Phone },
          { title: t.navigation.moduleSidebar.welddesk.voiceAgents, href: '/welddesk/ai-agents', icon: Bot },
          { title: t.navigation.moduleSidebar.welddesk.chatWidget, href: '/welddesk/chat-widget', icon: MessagesSquare },
          { title: t.navigation.moduleSidebar.welddesk.email, href: '/welddesk/email', icon: Mail },
          { title: t.navigation.moduleSidebar.welddesk.helpCenter, href: '/welddesk/help-center', icon: BookOpen },
          { title: t.navigation.moduleSidebar.welddesk.articles, href: '/welddesk/help-center/articles', icon: FileText },
          { title: 'Phone settings', href: '/welddesk/settings/phone', icon: Settings },
        ],
      },
    ],
  },
  weldmail: {
    appName: 'WeldMail',
    appIcon: Mail,
    appLogo: getAppLogoConfig('weldmail'),
    getMenuItems: () => [],
  },
  weldflow: {
    appName: 'WeldFlow',
    appIcon: Briefcase,
    appLogo: getAppLogoConfig('weldflow'),
    getMenuItems: () => [],
  },
  weldcalendar: {
    appName: 'WeldCalendar',
    appIcon: CalendarDays,
    appLogo: getAppLogoConfig('weldcalendar'),
    getMenuItems: () => [],
  },
  weldmeet: {
    appName: 'WeldMeet',
    appIcon: Video,
    appLogo: getAppLogoConfig('weldmeet'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldmeet.newMeeting, href: '/weldmeet', icon: Plus },
          { title: t.navigation.moduleSidebar.weldmeet.upcoming, href: '/weldmeet/upcoming', icon: Calendar },
          { title: t.navigation.moduleSidebar.weldmeet.history, href: '/weldmeet/history', icon: History },
          { title: t.navigation.moduleSidebar.weldmeet.people, href: '/weldmeet/people', icon: User },
        ],
      },
    ],
  },
  weldknow: {
    appName: 'WeldKnow',
    appIcon: BookOpen,
    appLogo: getAppLogoConfig('weldknow'),
    getMenuItems: () => [],
  },
  weldchat: {
    appName: 'WeldChat',
    appIcon: MessagesSquare,
    appLogo: getAppLogoConfig('weldchat'),
    getMenuItems: () => [],
  },
  weldcall: {
    appName: 'WeldCall',
    appIcon: Phone,
    appLogo: getAppLogoConfig('weldcall'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldcall.newCall, href: '/weldcall', icon: Plus },
          { title: t.navigation.moduleSidebar.weldcall.history, href: '/weldcall/history', icon: History },
          { title: t.navigation.moduleSidebar.weldcall.contacts, href: '/weldcall/contacts', icon: Contact },
        ],
      },
    ],
  },
  welddrive: {
    appName: 'WeldDrive',
    appIcon: HardDrive,
    appLogo: getAppLogoConfig('welddrive'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.welddrive.myDrive, href: '/welddrive', icon: HardDrive },
          { title: t.navigation.moduleSidebar.welddrive.sharedWithMe, href: '/welddrive/shared', icon: Share2 },
          { title: t.navigation.moduleSidebar.welddrive.allFiles, href: '/welddrive/all-files', icon: FolderOpen },
          { title: t.navigation.moduleSidebar.welddrive.recent, href: '/welddrive/recent', icon: Clock },
          { title: t.navigation.moduleSidebar.welddrive.starred, href: '/welddrive/starred', icon: Star },
          { title: t.navigation.moduleSidebar.welddrive.uploads, href: '/welddrive/uploads', icon: CloudUpload },
          { title: t.navigation.moduleSidebar.welddrive.trash, href: '/welddrive/trash', icon: Trash2 },
        ],
      },
    ],
  },
  weldbooks: {
    appName: 'WeldBooks',
    appIcon: Calculator,
    appLogo: getAppLogoConfig('weldbooks'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.overview,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.dashboard, href: '/weldbooks', icon: LayoutDashboard },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.sales,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.invoices, href: '/weldbooks/invoices', icon: FileText },
          { title: t.navigation.moduleSidebar.weldbooks.creditNotes, href: '/weldbooks/credit-notes', icon: Receipt },
          { title: t.navigation.moduleSidebar.weldbooks.recurring, href: '/weldbooks/recurring', icon: RefreshCw },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.purchases,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.bills, href: '/weldbooks/bills', icon: CreditCard },
          { title: t.navigation.moduleSidebar.weldbooks.documents, href: '/weldbooks/documents', icon: FileSearch },
          { title: t.navigation.moduleSidebar.weldbooks.paymentRuns, href: '/weldbooks/payment-runs', icon: Banknote },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.banking,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.bankAccounts, href: '/weldbooks/banking', icon: Landmark },
          { title: t.navigation.moduleSidebar.weldbooks.transactions, href: '/weldbooks/banking/transactions', icon: ArrowLeftRight },
          { title: t.navigation.moduleSidebar.weldbooks.reconciliation, href: '/weldbooks/banking/reconciliation', icon: Building2 },
          { title: t.navigation.moduleSidebar.weldbooks.rules, href: '/weldbooks/banking/rules', icon: Wand2 },
          { title: t.navigation.moduleSidebar.weldbooks.statementReconciliation, href: '/weldbooks/banking/statements', icon: ClipboardCheck },
          { title: t.navigation.moduleSidebar.weldbooks.deposits, href: '/weldbooks/deposits', icon: Wallet },
          { title: t.navigation.moduleSidebar.weldbooks.bankFeeds, href: '/weldbooks/banking/feeds', icon: Link2 },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.accounting,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.chartOfAccounts, href: '/weldbooks/accounts', icon: BookOpen },
          { title: t.navigation.moduleSidebar.weldbooks.journalEntries, href: '/weldbooks/journal', icon: Calculator },
          { title: t.navigation.moduleSidebar.weldbooks.vatReturns, href: '/weldbooks/vat', icon: Receipt },
          { title: t.navigation.moduleSidebar.weldbooks.fixedAssets, href: '/weldbooks/fixed-assets', icon: Boxes },
          { title: t.navigation.moduleSidebar.weldbooks.payroll, href: '/weldbooks/payroll', icon: UsersRound },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.tax,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.salesTaxCenter, href: '/weldbooks/sales-tax', icon: Percent },
          { title: t.navigation.moduleSidebar.weldbooks.exemptionCertificates, href: '/weldbooks/sales-tax/certificates', icon: ShieldCheck },
          { title: t.navigation.moduleSidebar.weldbooks.nexus, href: '/weldbooks/sales-tax/nexus', icon: Radar },
          { title: t.navigation.moduleSidebar.weldbooks.form1099, href: '/weldbooks/form-1099', icon: FileText },
          { title: t.navigation.moduleSidebar.weldbooks.taxCalendar, href: '/weldbooks/tax-calendar', icon: CalendarClock },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.contacts,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.customers, href: '/weldbooks/customers', icon: Users },
          { title: t.navigation.moduleSidebar.weldbooks.suppliers, href: '/weldbooks/suppliers', icon: Truck },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.reports,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.profitLoss, href: '/weldbooks/reports/profit-loss', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.weldbooks.balanceSheet, href: '/weldbooks/reports/balance-sheet', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.weldbooks.trialBalance, href: '/weldbooks/reports/trial-balance', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.weldbooks.agedReceivables, href: '/weldbooks/reports/aged-receivables', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.weldbooks.agedPayables, href: '/weldbooks/reports/aged-payables', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.weldbooks.taxWorksheet, href: '/weldbooks/reports/tax-worksheet', icon: FileSpreadsheet },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.settings,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.entities, href: '/weldbooks/entities', icon: Building2 },
          { title: t.navigation.moduleSidebar.weldbooks.fiscalPeriods, href: '/weldbooks/fiscal-periods', icon: CalendarRange },
          { title: t.navigation.moduleSidebar.weldbooks.dimensions, href: '/weldbooks/settings/dimensions', icon: Layers },
          { title: t.navigation.moduleSidebar.weldbooks.settings, href: '/weldbooks/settings', icon: Settings },
        ],
      },
    ],
  },
  agents: {
    appName: 'WeldAgent',
    appIcon: Bot,
    appLogo: getAppLogoConfig('weldagent'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.agents.allAgents, href: '/agents', icon: Bot },
        ],
      },
    ],
  },
  social: {
    appName: 'WeldSocial',
    appIcon: Share2,
    appLogo: getAppLogoConfig('social'),
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.social.dashboard, href: '/social/dashboard', icon: LayoutDashboard },
          { title: t.navigation.moduleSidebar.social.queue, href: '/social/queue', icon: Clock },
          { title: t.navigation.moduleSidebar.social.calendar, href: '/social/calendar', icon: CalendarDays },
          { title: t.navigation.moduleSidebar.social.drafts, href: '/social/drafts', icon: FileText },
          { title: t.navigation.moduleSidebar.social.analytics, href: '/social/analytics', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.social.campaigns, href: '/social/campaigns', icon: Megaphone },
          { title: t.navigation.moduleSidebar.social.approvals, href: '/social/approvals', icon: CircleCheck },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.settings,
        items: [
          { title: t.navigation.moduleSidebar.social.accounts, href: '/social/accounts', icon: Link2 },
          { title: t.navigation.moduleSidebar.social.team, href: '/social/team', icon: Users },
          { title: t.navigation.moduleSidebar.social.settings, href: '/social/settings', icon: Settings },
        ],
      },
    ],
  },
  home: {
    appName: 'WeldSuite',
    appIcon: Sparkles,
    appLogo: getAppLogoConfig('weldsuite'),
    getMenuItems: () => [],
  },
  // Menu, translated title and back button come from useSettingsSidebarItems.
  settings: {
    appName: 'Settings',
    appIcon: ChevronLeft,
    getMenuItems: () => [],
  },
};

export function getModuleKey(pathname: string): string | null {
  if (pathname.startsWith('/preview/help-docs')) {
    return 'weldhost';
  }
  if (pathname === '/' || pathname === '' || pathname === '/new-chat' || pathname.startsWith('/new-chat/')) {
    return 'home';
  }
  // Hosted WeldApps: `/apps/{code}` (+ optional subpaths for sidebar sections).
  const userAppMatch = /^\/apps\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(pathname);
  if (userAppMatch) {
    return `user-app:${userAppMatch[1]}`;
  }
  // WeldObjects custom objects: `/objects/{slug}` (+ `/{recordId}`).
  const objectMatch = /^\/objects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (objectMatch) {
    return `object:${objectMatch[1]}`;
  }
  const first = pathname.split('/').find(Boolean);
  if (first && MODULE_CONFIGS[first]) {
    return first;
  }
  return null;
}
