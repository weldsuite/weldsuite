import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Home,
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
  CalendarClock,
  HardDrive,
  Clock,
  Trash2,
  CloudUpload,
  Share2,
  Mail,
  MessageCircle,
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
  MessageSquarePlus,
  Database,
  Search,
  Megaphone,
  Link2,
  CircleCheck,
} from 'lucide-react';
import type { MenuGroupProps, AppLogo } from '@/components/app-sidebar-layout';
import type { TranslationsType } from '@/lib/i18n/types';
import { getAppLogoConfig } from '@/lib/apps/app-registry';


export interface ModuleSidebarConfig {
  appName: string;
  appIcon: LucideIcon;
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
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [
          { title: t.navigation.moduleSidebar.weldconnect.overview, href: '/weldconnect', icon: Home },
          { title: t.navigation.moduleSidebar.weldconnect.workflows, href: '/weldconnect/workflows', icon: Workflow },
          { title: t.navigation.moduleSidebar.weldconnect.templates, href: '/weldconnect/templates', icon: BookOpen },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.execution,
        items: [
          { title: t.navigation.moduleSidebar.weldconnect.executions, href: '/weldconnect/executions', icon: History },
        ],
      },
    ],
  },
  welddesk: {
    appName: 'WeldDesk',
    appIcon: Headphones,
    appLogo: getAppLogoConfig('welddesk'),
    getMenuItems: (t) => [
      {
        group: '',
        items: [
          { title: t.navigation.moduleSidebar.welddesk.dashboard, href: '/welddesk', icon: Home },
          { title: t.navigation.moduleSidebar.welddesk.analytics, href: '/welddesk/analytics', icon: BarChart3 },
          { title: t.navigation.moduleSidebar.welddesk.chatWidget, href: '/welddesk/chat-widget', icon: MessagesSquare },
          { title: t.navigation.moduleSidebar.welddesk.knowledge, href: '/welddesk/knowledge', icon: BookOpen },
          { title: t.navigation.moduleSidebar.welddesk.contacts, href: '/welddesk/contacts', icon: Users },
          { title: t.navigation.moduleSidebar.welddesk.reviews, href: '/welddesk/reviews', icon: Star },
          { title: t.navigation.moduleSidebar.welddesk.allTeams, href: '/welddesk/teams', icon: Users },
          { title: t.navigation.moduleSidebar.welddesk.workflows, href: '/welddesk/workflows', icon: Workflow },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.ai,
        items: [
          { title: t.navigation.moduleSidebar.welddesk.weldagent, href: '/welddesk/weldagent', icon: Bot },
          { title: t.navigation.moduleSidebar.welddesk.active, href: '/welddesk/ai-active', icon: MessageCircle },
          { title: t.navigation.moduleSidebar.welddesk.resolved, href: '/welddesk/ai-resolved', icon: SquareCheck },
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
          { title: t.navigation.moduleSidebar.weldmeet.upcoming, href: '/weldmeet/upcoming', icon: CalendarClock },
          { title: t.navigation.moduleSidebar.weldmeet.history, href: '/weldmeet/history', icon: History },
          { title: t.navigation.moduleSidebar.weldmeet.people, href: '/weldmeet/people', icon: Users },
        ],
      },
    ],
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
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.banking,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.bankAccounts, href: '/weldbooks/banking', icon: Landmark },
          { title: t.navigation.moduleSidebar.weldbooks.transactions, href: '/weldbooks/banking/transactions', icon: ArrowLeftRight },
          { title: t.navigation.moduleSidebar.weldbooks.reconciliation, href: '/weldbooks/banking/reconciliation', icon: Building2 },
          { title: t.navigation.moduleSidebar.weldbooks.rules, href: '/weldbooks/banking/rules', icon: Wand2 },
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.accounting,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.chartOfAccounts, href: '/weldbooks/accounts', icon: BookOpen },
          { title: t.navigation.moduleSidebar.weldbooks.journalEntries, href: '/weldbooks/journal', icon: Calculator },
          { title: t.navigation.moduleSidebar.weldbooks.vatReturns, href: '/weldbooks/vat', icon: Receipt },
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
        ],
      },
      {
        group: t.navigation.moduleSidebar.groups.settings,
        items: [
          { title: t.navigation.moduleSidebar.weldbooks.entities, href: '/weldbooks/entities', icon: Building2 },
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
};

export function getModuleKey(pathname: string): string | null {
  if (pathname === '/' || pathname === '' || pathname === '/new-chat' || pathname.startsWith('/new-chat/')) {
    return 'home';
  }
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (first && MODULE_CONFIGS[first]) {
    return first;
  }
  return null;
}
