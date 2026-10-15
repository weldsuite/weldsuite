
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Plus, Copy, Trash2, Check, AlertCircle, Pencil, EllipsisVertical } from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { FilterPills, type ActiveFilter, type FilterConfig } from "@/components/entity-list"
import { cn } from "@/lib/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weldsuite/ui/components/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@weldsuite/ui/components/dialog"
import { Input } from "@weldsuite/ui/components/input"
import { Label } from "@weldsuite/ui/components/label"
import { Textarea } from "@weldsuite/ui/components/textarea"
import { Alert, AlertDescription } from "@weldsuite/ui/components/alert"
import { Checkbox } from "@weldsuite/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu"
import {
  useWorkspaceApiKeys,
  useCreateWorkspaceApiKey,
  useRevokeWorkspaceApiKey,
  useUpdateWorkspaceApiKey,
} from "@/hooks/queries/use-settings-queries"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"

// Entity-based permissions grouped by module.
// IMPORTANT: every scope below must correspond to a scope enforced by the
// external API (apps/workers/external-api/src/routes/v1/**, via requireScope(...)).
// When you add or rename a route scope there, mirror it here. Read-only
// resources simply omit the write scope.
const rw = (object: string) => [{ id: `${object}:read`, label: 'Read' }, { id: `${object}:write`, label: 'Write' }];
const ro = (object: string) => [{ id: `${object}:read`, label: 'Read' }];

// Scopes the external API only grants by name: `*` and `<object>:*` never
// include them (external-api `NAMED_ONLY_SCOPES`). The bulk "All" buttons skip
// them too, so a key can only send mail (or answer WeldReach prospects) when
// someone ticked Send or Reply on purpose.
const NAMED_ONLY_SCOPES = ['mail_messages:send', 'reach_inbox:reply'];

const PERMISSION_ENTITIES = [
  // CRM
  { entity: 'People', group: 'CRM', description: 'CRM contacts', scopes: rw('people') },
  { entity: 'Companies', group: 'CRM', description: 'CRM companies', scopes: rw('companies') },
  { entity: 'Leads', group: 'CRM', description: 'CRM leads', scopes: rw('leads') },
  { entity: 'Opportunities', group: 'CRM', description: 'CRM opportunities', scopes: rw('opportunities') },
  { entity: 'Pipelines', group: 'CRM', description: 'CRM pipelines', scopes: rw('pipelines') },
  { entity: 'Pipeline Stages', group: 'CRM', description: 'CRM pipeline stages', scopes: rw('pipeline_stages') },
  { entity: 'Activities', group: 'CRM', description: 'CRM activities', scopes: rw('activities') },
  { entity: 'Quotes', group: 'CRM', description: 'CRM quotes', scopes: rw('quotes') },
  // Commerce
  { entity: 'Products', group: 'Commerce', description: 'Commerce products', scopes: rw('products') },
  { entity: 'Orders', group: 'Commerce', description: 'Commerce orders', scopes: rw('orders') },
  // Projects
  { entity: 'Projects', group: 'Projects', description: 'Project management', scopes: rw('projects') },
  { entity: 'Tasks', group: 'Projects', description: 'Project tasks', scopes: rw('tasks') },
  { entity: 'Task Comments', group: 'Projects', description: 'Task comments', scopes: rw('task_comments') },
  { entity: 'Task Tags', group: 'Projects', description: 'Task tags', scopes: rw('task_tags') },
  { entity: 'Milestones', group: 'Projects', description: 'Project milestones', scopes: rw('milestones') },
  { entity: 'Sprints', group: 'Projects', description: 'Project sprints', scopes: rw('sprints') },
  { entity: 'Goals', group: 'Projects', description: 'Project goals', scopes: rw('goals') },
  { entity: 'Time Entries', group: 'Projects', description: 'Time tracking', scopes: rw('time_entries') },
  { entity: 'Project Members', group: 'Projects', description: 'Project team members', scopes: rw('project_members') },
  { entity: 'Project Labels', group: 'Projects', description: 'Project labels', scopes: rw('project_labels') },
  { entity: 'Project Documents', group: 'Projects', description: 'Project documents', scopes: rw('project_documents') },
  { entity: 'Project Files', group: 'Projects', description: 'Project files', scopes: rw('project_files') },
  { entity: 'Project Messages', group: 'Projects', description: 'Project messages', scopes: rw('project_messages') },
  { entity: 'Project Sheets', group: 'Projects', description: 'Project sheets', scopes: ro('project_sheets') },
  { entity: 'Whiteboards', group: 'Projects', description: 'Project whiteboards', scopes: rw('whiteboards') },
  // Helpdesk
  { entity: 'Tickets', group: 'Helpdesk', description: 'Helpdesk tickets and messages', scopes: rw('tickets') },
  { entity: 'Articles', group: 'Helpdesk', description: 'Knowledge base articles', scopes: rw('articles') },
  { entity: 'Conversations', group: 'Helpdesk', description: 'Helpdesk conversations', scopes: rw('conversations') },
  // Files
  { entity: 'Files', group: 'Files', description: 'Drive files', scopes: rw('files') },
  { entity: 'Folders', group: 'Files', description: 'Drive folders', scopes: rw('folders') },
  { entity: 'Drive', group: 'Files', description: 'Aggregated drive listing and stats', scopes: ro('drive') },
  // Calendar
  { entity: 'Calendars', group: 'Calendar', description: 'Calendars', scopes: rw('calendars') },
  { entity: 'Calendar Events', group: 'Calendar', description: 'Calendar events', scopes: rw('calendar_events') },
  // WeldMail — workspace keys reach shared mailboxes only; personal keys follow their owner's access.
  { entity: 'Mail Accounts', group: 'WeldMail', description: 'Mailboxes (no credentials)', scopes: ro('mail_accounts') },
  {
    entity: 'Messages',
    group: 'WeldMail',
    description: 'Emails and threads; Send covers send, reply, forward and draft-send',
    scopes: [...rw('mail_messages'), { id: 'mail_messages:send', label: 'Send' }],
  },
  { entity: 'Drafts', group: 'WeldMail', description: 'Unsent emails', scopes: rw('mail_drafts') },
  { entity: 'Labels', group: 'WeldMail', description: 'Mailbox labels', scopes: rw('mail_labels') },
  { entity: 'Folders', group: 'WeldMail', description: 'Mailbox folders', scopes: rw('mail_folders') },
  { entity: 'Attachments', group: 'WeldMail', description: 'Download files; write uploads files to send', scopes: rw('mail_attachments') },
  // WeldReach (on request only: a key gets 403 APP_ACCESS_REQUIRED until WeldSuite approves the workspace).
  // Creating or deleting mailboxes and domains stays in the app, because every inbox is billed.
  { entity: 'Campaigns', group: 'WeldReach', description: 'Campaigns, steps, enrollments, launch and pause, stats', scopes: rw('reach_campaigns') },
  { entity: 'Prospects', group: 'WeldReach', description: 'Prospects, imports and prospect lists', scopes: rw('reach_prospects') },
  { entity: 'Suppressions', group: 'WeldReach', description: 'Addresses and domains that are never emailed', scopes: rw('reach_settings') },
  {
    entity: 'Reply Inbox',
    group: 'WeldReach',
    description: 'Replies to campaigns; Reply sends an answer to a prospect',
    scopes: [...ro('reach_inbox'), { id: 'reach_inbox:reply', label: 'Reply' }],
  },
  { entity: 'Mailboxes', group: 'WeldReach', description: 'Sending mailboxes and domains, warmup status (no credentials)', scopes: ro('reach_mailboxes') },
  // Chat
  { entity: 'Channels', group: 'Chat', description: 'Chat channels', scopes: rw('channels') },
  { entity: 'Channel Members', group: 'Chat', description: 'Chat channel members', scopes: rw('channel_members') },
  { entity: 'Messages', group: 'Chat', description: 'Chat messages', scopes: rw('chat_messages') },
  { entity: 'Sections', group: 'Chat', description: 'Chat sections', scopes: rw('chat_sections') },
  { entity: 'Drafts', group: 'Chat', description: 'Chat drafts', scopes: rw('chat_drafts') },
  { entity: 'Bookmarks', group: 'Chat', description: 'Chat bookmarks', scopes: rw('chat_bookmarks') },
  // Host
  { entity: 'Domains', group: 'Host', description: 'Domains, DNS zones and records', scopes: rw('domains') },
  // Automation
  { entity: 'Workflows', group: 'Automation', description: 'Workflows, schedules and executions', scopes: rw('workflows') },
  { entity: 'Webhooks', group: 'Automation', description: 'Webhook subscriptions', scopes: rw('webhooks') },
  // WeldBooks — the public API reads accounting data; only contacts can be
  // written there (documents are posted through the books services).
  { entity: 'Accounting Entities', group: 'WeldBooks', description: 'Legal entities and books', scopes: ro('accounting_entities') },
  { entity: 'GL Accounts', group: 'WeldBooks', description: 'Chart of accounts', scopes: ro('gl_accounts') },
  { entity: 'Invoices', group: 'WeldBooks', description: 'Customer invoices (AR)', scopes: ro('invoices') },
  { entity: 'Bills', group: 'WeldBooks', description: 'Supplier bills (AP)', scopes: ro('bills') },
  { entity: 'Journal Entries', group: 'WeldBooks', description: 'Manual journal entries', scopes: ro('journal_entries') },
  { entity: 'Payments', group: 'WeldBooks', description: 'Payments on invoices and bills', scopes: ro('payments') },
  { entity: 'Bank Accounts', group: 'WeldBooks', description: 'Linked bank accounts', scopes: ro('bank_accounts') },
  { entity: 'Bank Transactions', group: 'WeldBooks', description: 'Bank statement lines', scopes: ro('bank_transactions') },
  { entity: 'Accounting Contacts', group: 'WeldBooks', description: 'Customers and suppliers', scopes: rw('accounting_contacts') },
  { entity: 'Tax Rates', group: 'WeldBooks', description: 'VAT / GST rates', scopes: ro('tax_rates') },
  { entity: 'Recurring Invoices', group: 'WeldBooks', description: 'Scheduled invoice templates', scopes: ro('recurring_invoices') },
  { entity: 'Reconciliation Rules', group: 'WeldBooks', description: 'Auto-match bank transactions', scopes: ro('reconciliation_rules') },
  { entity: 'Fiscal Periods', group: 'WeldBooks', description: 'Open and closed periods', scopes: ro('fiscal_periods') },
  { entity: 'FX Rates', group: 'WeldBooks', description: 'Exchange rates', scopes: ro('fx_rates') },
  { entity: 'VAT Returns', group: 'WeldBooks', description: 'Periodic VAT filings', scopes: ro('vat_returns') },
  { entity: 'Accounting Documents', group: 'WeldBooks', description: 'Receipts and supporting files', scopes: ro('accounting_documents') },
  { entity: 'ICP Declarations', group: 'WeldBooks', description: 'Intracommunity supply declarations', scopes: ro('icp_declarations') },
  { entity: 'Accounting Settings', group: 'WeldBooks', description: 'Workspace accounting defaults', scopes: ro('accounting_settings') },
  // Settings
  { entity: 'Workspace Settings', group: 'Settings', description: 'Workspace configuration', scopes: ro('settings') },
  { entity: 'Members', group: 'Settings', description: 'Workspace members', scopes: ro('members') },
] as const;

// Get all scope IDs the bulk buttons may select (named-only scopes excluded)
const ALL_SCOPES = PERMISSION_ENTITIES.flatMap(e => e.scopes.map(s => s.id)).filter(
  (id) => !NAMED_ONLY_SCOPES.includes(id),
);

type ScopeAction = 'read' | 'write' | 'send' | 'reply';

// Actions that only exist as named-only scopes; a group gets a column for each one it has.
const NAMED_ONLY_ACTIONS = ['send', 'reply'] as const satisfies readonly ScopeAction[];

const ACTION_HEADER_KEYS: Record<ScopeAction, string> = {
  read: 'sweep.settings.apiKeys.table.read',
  write: 'sweep.settings.apiKeys.table.write',
  send: 'sweep.settings.apiKeys.table.send',
  reply: 'sweep.settings.apiKeys.table.reply',
};

const NAMED_ONLY_HINT_KEYS: Record<(typeof NAMED_ONLY_ACTIONS)[number], string> = {
  send: 'sweep.settings.apiKeys.sendScopeHint',
  reply: 'sweep.settings.apiKeys.replyScopeHint',
};

// Module logo per permission group
const GROUP_LOGOS: Record<string, string> = {
  CRM: '/assets/images/weldcrm/icon.svg',
  Commerce: '/assets/images/weldsuite/icon.svg',
  Projects: '/assets/images/weldflow/icon-projects.svg',
  Helpdesk: '/assets/images/welddesk/icon.svg',
  Files: '/assets/images/welddrive/icon.svg',
  Calendar: '/assets/images/weldcalendar/icon.svg',
  WeldMail: '/assets/images/weldmail/icon.svg',
  WeldReach: '/assets/images/weldreach/icon.svg',
  Chat: '/assets/images/weldchat/icon.svg',
  Host: '/assets/images/weldhost/icon.svg',
  Automation: '/assets/images/weldconnect/icon.svg',
  WeldBooks: '/assets/images/weldbooks/icon.svg?v=2',
  Settings: '/assets/images/weldsuite/icon.svg',
};

export interface WorkspaceApiKey {
  id: string;
  name: string;
  description?: string;
  keyPrefix: string;
  key?: string;
  scopes?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

type PermissionEntity = typeof PERMISSION_ENTITIES[number]

// Consecutive entities that share a group are rendered as one table.
function groupPermissionEntities(): { group: string; entities: PermissionEntity[] }[] {
  const groups: { group: string; entities: PermissionEntity[] }[] = [];
  for (const entity of PERMISSION_ENTITIES) {
    const last = groups.at(-1);
    if (last?.group === entity.group) {
      last.entities.push(entity);
    } else {
      groups.push({ group: entity.group, entities: [entity] });
    }
  }
  return groups;
}

// One permission group: a table of entities with read/write scope checkboxes.
function PermissionGroupTable({
  group,
  entities,
  selectedScopes,
  onToggleScope,
}: Readonly<{
  group: string;
  entities: PermissionEntity[];
  selectedScopes: string[];
  onToggleScope: (scopeId: string) => void;
}>) {
  const t = useTranslations();
  const groupLogo = GROUP_LOGOS[group];
  // A Send or Reply column only for groups that have such a scope (WeldMail, WeldReach).
  const namedOnlyActions = NAMED_ONLY_ACTIONS.filter((action) =>
    entities.some((e) => e.scopes.some((s) => s.id.endsWith(`:${action}`))),
  );
  const actions: ScopeAction[] = ['read', 'write', ...namedOnlyActions];
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="bg-muted/40 px-3 py-1.5 text-[13px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/40">
        <span className="inline-flex items-center gap-1.5">
          {groupLogo && <img src={groupLogo} alt="" className="h-3.5 w-3.5" />}
          {group}
        </span>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead className="bg-background">
          <tr>
            <th className="text-left px-3 py-2 font-medium border-b border-border/40">{t('sweep.settings.apiKeys.table.entity')}</th>
            {actions.map((action) => (
              <th key={action} className="text-center px-3 py-2 font-medium w-20 border-b border-border/40">
                {t(ACTION_HEADER_KEYS[action])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entities.map((entity, idx) => {
            const isLast = idx === entities.length - 1;
            const cellBorder = isLast ? '' : 'border-b border-border/40';
            return (
              <tr key={entity.entity} className="bg-background">
                <td className={cn('px-3 py-2', cellBorder)}>
                  <div className="font-medium">{entity.entity}</div>
                  <div className="text-xs text-muted-foreground">{entity.description}</div>
                </td>
                {actions.map((action) => (
                  <PermissionScopeCell
                    key={action}
                    entity={entity}
                    action={action}
                    cellBorder={cellBorder}
                    selectedScopes={selectedScopes}
                    onToggleScope={onToggleScope}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {namedOnlyActions.map((action) => (
        <p key={action} className="border-t border-border/40 bg-background px-3 py-2 text-xs text-muted-foreground">
          {t(NAMED_ONLY_HINT_KEYS[action])}
        </p>
      ))}
    </div>
  );
}

// Read, write, send or reply scope checkbox cell for an entity ("—" when the scope does not exist).
function PermissionScopeCell({
  entity,
  action,
  cellBorder,
  selectedScopes,
  onToggleScope,
}: Readonly<{
  entity: PermissionEntity;
  action: ScopeAction;
  cellBorder: string;
  selectedScopes: string[];
  onToggleScope: (scopeId: string) => void;
}>) {
  const t = useTranslations();
  const scope = entity.scopes.find((s) => s.id.endsWith(`:${action}`));
  return (
    <td className={cn('text-center px-3 py-2', cellBorder)}>
      {scope ? (
        <Checkbox
          checked={selectedScopes.includes(scope.id)}
          onCheckedChange={() => onToggleScope(scope.id)}
        />
      ) : (
        <span className="text-muted-foreground/40" title={t('sweep.settings.apiKeys.notAvailable')}>—</span>
      )}
    </td>
  );
}

// Permissions selector component
function PermissionsSelector({
  selectedScopes,
  onToggleScope,
  onSelectAllRead,
  onSelectAllWrite,
  onSelectAll,
  onClearAll,
  className,
}: Readonly<{
  selectedScopes: string[];
  onToggleScope: (scopeId: string) => void;
  onSelectAllRead: () => void;
  onSelectAllWrite: () => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  className?: string;
}>) {
  const t = useTranslations();
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2', className)}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Label>{t('sweep.settings.apiKeys.permissionsLabel')}</Label>
        <div className="flex flex-wrap justify-end gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onSelectAllRead}>
            {t('sweep.settings.apiKeys.allRead')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onSelectAllWrite}>
            {t('sweep.settings.apiKeys.allWrite')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onSelectAll}>
            {t('sweep.settings.apiKeys.all')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClearAll}>
            {t('sweep.settings.apiKeys.clear')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <div className="space-y-3">
        {groupPermissionEntities().map(({ group, entities }) => (
          <PermissionGroupTable
            key={group}
            group={group}
            entities={entities}
            selectedScopes={selectedScopes}
            onToggleScope={onToggleScope}
          />
        ))}
        </div>
      </div>
      {selectedScopes.length > 0 && (
        <p className="shrink-0 text-xs text-muted-foreground">
          {t('sweep.settings.apiKeys.selectedCount', { count: selectedScopes.length })}
        </p>
      )}
    </div>
  );
}

// "usage" filter pill: keep used keys ('used') or never-used keys ('unused').
function matchesUsageFilter(key: WorkspaceApiKey, value: string): boolean {
  const used = !!key.lastUsedAt
  if (value === 'used' && !used) return false
  if (value === 'unused' && used) return false
  return true
}

// True when `key` passes every active filter pill and the (lower-cased) search query.
function matchesApiKeyFilters(key: WorkspaceApiKey, activeFilters: ActiveFilter[], query: string): boolean {
  for (const f of activeFilters) {
    if (!f.value) continue
    if (f.field === 'usage' && !matchesUsageFilter(key, f.value)) return false
  }
  if (query) {
    const haystack = [key.name, key.description, key.keyPrefix].filter(Boolean).join(' ').toLowerCase()
    if (!haystack.includes(query)) return false
  }
  return true
}

export function ApiKeysSection() {
  const t = useTranslations()
  const [error, setError] = React.useState<string | null>(null)
  const [createdKey, setCreatedKey] = React.useState<WorkspaceApiKey | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)

  // Standard filter row state
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([])
  const [searchQuery, setSearchQuery] = React.useState("")

  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'usage',
      label: t('sweep.settings.apiKeys.filters.usage'),
      filterType: 'select',
      options: [
        { value: 'used', label: t('sweep.settings.apiKeys.filters.used') },
        { value: 'unused', label: t('sweep.settings.apiKeys.filters.neverUsedOption') },
      ],
    },
  ], [t])

  // React Query hooks
  const { data: apiKeysData, isLoading: loading } = useWorkspaceApiKeys()
  const createMutation = useCreateWorkspaceApiKey()
  const revokeMutation = useRevokeWorkspaceApiKey()
  const updateMutation = useUpdateWorkspaceApiKey()
  const apiKeys = (apiKeysData?.data as WorkspaceApiKey[]) ?? []

  const filteredApiKeys = React.useMemo(() => {
    const apiKeys = (apiKeysData?.data as WorkspaceApiKey[]) ?? []
    const q = searchQuery.trim().toLowerCase()
    return apiKeys.filter((k) => matchesApiKeyFilters(k, activeFilters, q))
  }, [apiKeysData, activeFilters, searchQuery])

  // Create key dialog state
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  const [keyDescription, setKeyDescription] = React.useState("")
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([])
  const creating = createMutation.isPending

  // Edit key dialog state
  const [editDialogOpen, setEditDialogOpen] = React.useState(false)
  const [editingKey, setEditingKey] = React.useState<WorkspaceApiKey | null>(null)
  const [editName, setEditName] = React.useState("")
  const [editDescription, setEditDescription] = React.useState("")
  const [editScopes, setEditScopes] = React.useState<string[]>([])
  const updating = updateMutation.isPending

  // Toggle scope selection
  const toggleScope = (scopeId: string, scopeList: string[], setScopeList: (scopes: string[]) => void) => {
    setScopeList(
      scopeList.includes(scopeId)
        ? scopeList.filter(s => s !== scopeId)
        : [...scopeList, scopeId]
    )
  }

  // Select all read scopes
  const selectAllRead = (setScopeList: (scopes: string[]) => void, currentScopes: string[]) => {
    const readScopes = ALL_SCOPES.filter(s => s.endsWith(':read'))
    const withoutRead = currentScopes.filter(s => !s.endsWith(':read'))
    setScopeList([...withoutRead, ...readScopes])
  }

  // Select all write scopes
  const selectAllWrite = (setScopeList: (scopes: string[]) => void, currentScopes: string[]) => {
    const writeScopes = ALL_SCOPES.filter(s => s.endsWith(':write'))
    const withoutWrite = currentScopes.filter(s => !s.endsWith(':write'))
    setScopeList([...withoutWrite, ...writeScopes])
  }

  // Select all scopes, keeping any named-only scope (Send, Reply) that was ticked by hand
  const selectAll = (setScopeList: (scopes: string[]) => void, currentScopes: string[]) => {
    setScopeList([...ALL_SCOPES, ...currentScopes.filter(s => NAMED_ONLY_SCOPES.includes(s))])
  }

  // Clear all scopes
  const clearAll = (setScopeList: (scopes: string[]) => void) => {
    setScopeList([])
  }

  // Create new API key
  const handleCreateKey = async () => {
    if (!keyName.trim()) {
      setError(t('sweep.settings.apiKeys.errors.nameRequired'))
      return
    }

    if (selectedScopes.length === 0) {
      setError(t('sweep.settings.apiKeys.errors.permissionRequired'))
      return
    }

    try {
      setError(null)
      const result = await createMutation.mutateAsync({
        name: keyName,
        description: keyDescription || undefined,
        scopes: selectedScopes,
      })

      if (result.success && result.data) {
        setCreatedKey({ ...result.data, createdAt: result.data.createdAt ?? new Date().toISOString() })
        setKeyName("")
        setKeyDescription("")
        setSelectedScopes([])
        setCreateDialogOpen(false)
      } else {
        setError((result as unknown as { error?: string }).error || t('sweep.settings.apiKeys.errors.createFailed'))
      }
    } catch (err) {
      console.error("Failed to create API key:", err)
      setError(err instanceof Error ? err.message : t('sweep.settings.apiKeys.errors.createFailed'))
    }
  }

  // Open edit dialog
  const openEditDialog = (key: WorkspaceApiKey) => {
    setEditingKey(key)
    setEditName(key.name)
    setEditDescription(key.description || "")
    setEditScopes(key.scopes || [])
    setEditDialogOpen(true)
  }

  // Update API key
  const handleUpdateKey = async () => {
    if (!editingKey) return

    if (!editName.trim()) {
      setError(t('sweep.settings.apiKeys.errors.nameRequired'))
      return
    }

    if (editScopes.length === 0) {
      setError(t('sweep.settings.apiKeys.errors.permissionRequired'))
      return
    }

    try {
      setError(null)
      const result = await updateMutation.mutateAsync({
        id: editingKey.id,
        data: {
          name: editName,
          description: editDescription || undefined,
          scopes: editScopes,
        },
      })

      if (result.success) {
        setEditDialogOpen(false)
        setEditingKey(null)
      } else {
        setError((result as unknown as { error?: string }).error || t('sweep.settings.apiKeys.errors.updateFailed'))
      }
    } catch (err) {
      console.error("Failed to update API key:", err)
      setError(err instanceof Error ? err.message : t('sweep.settings.apiKeys.errors.updateFailed'))
    }
  }

  // Revoke API key
  const handleRevokeKey = async (id: string, name: string) => {
    if (!confirm(t('sweep.settings.apiKeys.confirmRevoke', { name }))) {
      return
    }

    try {
      setError(null)
      await revokeMutation.mutateAsync(id)
    } catch (err) {
      console.error("Failed to revoke API key:", err)
      setError(err instanceof Error ? err.message : t('sweep.settings.apiKeys.errors.revokeFailed'))
    }
  }

  // Copy to clipboard
  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  // Format date with time — omit year when it matches the current year
  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const isCurrentYear = date.getFullYear() === new Date().getFullYear()
    return date.toLocaleString("en-US", {
      ...(isCurrentYear ? {} : { year: "numeric" }),
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  // Format last used with exact date and time
  const formatLastUsed = (dateString?: string) => {
    if (!dateString) return t('sweep.settings.apiKeys.neverUsed')
    return formatDate(dateString)
  }

  // Format scopes for display
  const formatScopesDisplay = (scopes: string[] | undefined) => {
    if (!scopes || scopes.length === 0) return <span className="text-xs text-muted-foreground">{t('sweep.settings.apiKeys.noneLabel')}</span>

    const readCount = scopes.filter(s => s.endsWith(':read')).length
    const writeCount = scopes.filter(s => s.endsWith(':write')).length

    return (
      <div className="flex gap-1">
        {readCount > 0 && (
          <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none font-normal border border-border bg-background text-foreground">
            {t('sweep.settings.apiKeys.readCountLabel', { count: readCount })}
          </span>
        )}
        {writeCount > 0 && (
          <span className="inline-flex items-center h-[22px] px-2 rounded text-xs leading-none font-normal border border-border bg-background text-foreground">
            {t('sweep.settings.apiKeys.writeCountLabel', { count: writeCount })}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.apiKeys.title')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.apiKeys.description')}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />
          </div>

          <div className="flex items-center gap-2">
            <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('sweep.settings.apiKeys.searchPlaceholder')} />
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-8">
                  <Plus className="h-4 w-4 mr-0.5" />
                  {t('sweep.settings.apiKeys.generateKey')}
                </Button>
              </DialogTrigger>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
              <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
                <DialogTitle>{t('sweep.settings.apiKeys.createDialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('sweep.settings.apiKeys.createDialog.description')}
                </DialogDescription>
              </DialogHeader>

              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-2">
                <div className="grid shrink-0 gap-2">
                  <Label htmlFor="name">{t('sweep.settings.apiKeys.nameLabel')}</Label>
                  <Input
                    id="name"
                    placeholder={t('sweep.settings.apiKeys.namePlaceholder')}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </div>

                <div className="grid shrink-0 gap-2">
                  <Label htmlFor="description">{t('sweep.settings.apiKeys.descriptionLabel')}</Label>
                  <Textarea
                    id="description"
                    placeholder={t('sweep.settings.apiKeys.descriptionPlaceholder')}
                    value={keyDescription}
                    onChange={(e) => setKeyDescription(e.target.value)}
                    rows={2}
                  />
                </div>

                <PermissionsSelector
                  selectedScopes={selectedScopes}
                  onToggleScope={(id) => toggleScope(id, selectedScopes, setSelectedScopes)}
                  onSelectAllRead={() => selectAllRead(setSelectedScopes, selectedScopes)}
                  onSelectAllWrite={() => selectAllWrite(setSelectedScopes, selectedScopes)}
                  onSelectAll={() => selectAll(setSelectedScopes, selectedScopes)}
                  onClearAll={() => clearAll(setSelectedScopes)}
                />
              </div>

              {error && createDialogOpen && (
                <Alert variant="destructive" className="mx-6 shrink-0">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <DialogFooter className="shrink-0 border-t px-6 py-4">
                <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                  {t('sweep.settings.apiKeys.cancel')}
                </Button>
                <Button onClick={handleCreateKey} disabled={creating || !keyName.trim() || selectedScopes.length === 0}>
                  {creating ? t('sweep.settings.apiKeys.creating') : t('sweep.settings.apiKeys.createButton')}
                </Button>
              </DialogFooter>
            </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Edit key dialog */}
        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
            <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
              <DialogTitle>{t('sweep.settings.apiKeys.editDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('sweep.settings.apiKeys.editDialog.description')}
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-2">
              <div className="grid shrink-0 gap-2">
                <Label htmlFor="edit-name">{t('sweep.settings.apiKeys.nameLabel')}</Label>
                <Input
                  id="edit-name"
                  placeholder={t('sweep.settings.apiKeys.namePlaceholder')}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <div className="grid shrink-0 gap-2">
                <Label htmlFor="edit-description">{t('sweep.settings.apiKeys.descriptionLabel')}</Label>
                <Textarea
                  id="edit-description"
                  placeholder={t('sweep.settings.apiKeys.descriptionPlaceholder')}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={2}
                />
              </div>

              <PermissionsSelector
                selectedScopes={editScopes}
                onToggleScope={(id) => toggleScope(id, editScopes, setEditScopes)}
                onSelectAllRead={() => selectAllRead(setEditScopes, editScopes)}
                onSelectAllWrite={() => selectAllWrite(setEditScopes, editScopes)}
                onSelectAll={() => selectAll(setEditScopes, editScopes)}
                onClearAll={() => clearAll(setEditScopes)}
              />
            </div>

            {error && editDialogOpen && (
              <Alert variant="destructive" className="mx-6 shrink-0">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="shrink-0 border-t px-6 py-4">
              <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
                {t('sweep.settings.apiKeys.cancel')}
              </Button>
              <Button onClick={handleUpdateKey} disabled={updating || !editName.trim() || editScopes.length === 0}>
                {updating ? t('sweep.settings.apiKeys.saving') : t('sweep.settings.apiKeys.saveChanges')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Show created key dialog */}
        {createdKey && (
          <Dialog open={!!createdKey} onOpenChange={() => setCreatedKey(null)}>
            <DialogContent className="sm:max-w-[650px]">
              <DialogHeader>
                <DialogTitle>{t('sweep.settings.apiKeys.createdDialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('sweep.settings.apiKeys.createdDialog.description')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {t('sweep.settings.apiKeys.createdDialog.copyWarning')}
                  </AlertDescription>
                </Alert>

                <div className="grid gap-2">
                  <Label>{t('sweep.settings.apiKeys.createdDialog.keyLabel')}</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm bg-muted px-3 py-2 rounded border font-mono break-all select-all">
                      {createdKey.key}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => createdKey.key && copyToClipboard(createdKey.key, "created")}
                    >
                      {copied === "created" ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button onClick={() => setCreatedKey(null)}>
                  {t('sweep.settings.apiKeys.createdDialog.savedButton')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {error && !createDialogOpen && !editDialogOpen && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            {t('sweep.settings.apiKeys.loadingKeys')}
          </div>
        )}
        {!loading && apiKeys.length === 0 && (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            <p>{t('sweep.settings.apiKeys.emptyState.title')}</p>
            <p className="text-sm mt-1">{t('sweep.settings.apiKeys.emptyState.subtitle')}</p>
          </div>
        )}
        {!loading && apiKeys.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[13.5px]">{t('sweep.settings.apiKeys.table.name')}</TableHead>
                  <TableHead className="text-[13.5px]">{t('sweep.settings.apiKeys.table.keyPrefix')}</TableHead>
                  <TableHead className="text-[13.5px]">{t('sweep.settings.apiKeys.table.permissions')}</TableHead>
                  <TableHead className="text-[13.5px]">{t('sweep.settings.apiKeys.table.created')}</TableHead>
                  <TableHead className="text-[13.5px]">{t('sweep.settings.apiKeys.table.lastUsed')}</TableHead>
                  <TableHead className="text-right text-[13.5px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredApiKeys.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      {t('sweep.settings.apiKeys.table.noMatch')}
                    </TableCell>
                  </TableRow>
                )}
                {filteredApiKeys.map((key) => (
                  <TableRow key={key.id} className="group">
                    <TableCell>
                      <div>
                        <div className="font-medium">{key.name}</div>
                        {key.description && (
                          <div className="text-sm text-muted-foreground">{key.description}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {key.keyPrefix}...
                      </code>
                    </TableCell>
                    <TableCell>
                      {formatScopesDisplay(key.scopes)}
                    </TableCell>
                    <TableCell className="text-[13.5px] font-mono text-muted-foreground">{formatDate(key.createdAt)}</TableCell>
                    <TableCell className="text-[13.5px] font-mono text-muted-foreground">{formatLastUsed(key.lastUsedAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                            >
                              <span className="sr-only">{t('sweep.settings.apiKeys.openMenu')}</span>
                              <EllipsisVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditDialog(key)}>
                              <Pencil className="h-4 w-4 mr-0.5" />
                              {t('sweep.settings.apiKeys.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleRevokeKey(key.id, key.name)}
                              className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                            >
                              <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                              {t('sweep.settings.apiKeys.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <Alert className="border-0 bg-transparent p-0 mt-8">
          <AlertDescription className="space-y-2">
            <div>
              <strong>{t('sweep.settings.apiKeys.docs.baseUrlLabel')}</strong>{" "}
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                {import.meta.env.VITE_EXTERNAL_API_URL || "https://api.weldsuite.org"}
              </code>
            </div>
            <div>
              <strong>{t('sweep.settings.apiKeys.docs.authLabel')}</strong> {t('sweep.settings.apiKeys.docs.authInstruction')}
              <br />
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded mt-1 inline-block">
                Authorization: Bearer wsk_your_api_key
              </code>
              <span className="text-xs text-muted-foreground ml-2">{t('sweep.settings.apiKeys.docs.or')}</span>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded ml-2">
                X-Api-Key: wsk_your_api_key
              </code>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}
