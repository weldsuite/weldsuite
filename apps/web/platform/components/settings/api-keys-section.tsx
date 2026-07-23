
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Plus, Copy, Trash2, Check, AlertCircle, Shield, Pencil, Lock, Sparkles, Search, EllipsisVertical } from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { FilterPills, type ActiveFilter, type FilterConfig } from "@/components/entity-list"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@weldsuite/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weldsuite/ui/components/table"
import { Badge } from "@weldsuite/ui/components/badge"
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
import { Separator } from "@weldsuite/ui/components/separator"
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
import { useAppApiClient } from '@/lib/api/use-app-api'
import { PricingDialog } from "@/components/pricing-dialog"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"

// Entity-based permissions grouped by module.
// IMPORTANT: every scope below must correspond to a scope enforced by the
// external API (apps/workers/external-api/src/routes/v1/**, via requireScope(...)).
// When you add or rename a route scope there, mirror it here. Read-only
// resources simply omit the write scope.
const rw = (object: string) => [{ id: `${object}:read`, label: 'Read' }, { id: `${object}:write`, label: 'Write' }];
const ro = (object: string) => [{ id: `${object}:read`, label: 'Read' }];

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
  // Settings
  { entity: 'Workspace Settings', group: 'Settings', description: 'Workspace configuration', scopes: ro('settings') },
  { entity: 'Members', group: 'Settings', description: 'Workspace members', scopes: ro('members') },
] as const;

// Get all scope IDs
const ALL_SCOPES = PERMISSION_ENTITIES.flatMap(e => e.scopes.map(s => s.id));

// Module logo per permission group
const GROUP_LOGOS: Record<string, string> = {
  CRM: '/assets/images/weldcrm/icon.svg',
  Commerce: '/assets/images/weldsuite/icon.svg',
  Projects: '/assets/images/weldflow/icon-projects.svg',
  Helpdesk: '/assets/images/welddesk/icon.svg',
  Files: '/assets/images/welddrive/icon.svg',
  Calendar: '/assets/images/weldcalendar/icon.svg',
  Chat: '/assets/images/weldchat/icon.svg',
  Host: '/assets/images/weldhost/icon.svg',
  Automation: '/assets/images/weldconnect/icon.svg',
  Settings: '/assets/images/weldsuite/icon.svg',
};

interface WorkspaceApiKey {
  id: string;
  name: string;
  description?: string;
  keyPrefix: string;
  key?: string;
  scopes?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

// Permissions selector component
function PermissionsSelector({
  selectedScopes,
  onToggleScope,
  onSelectAllRead,
  onSelectAllWrite,
  onSelectAll,
  onClearAll,
}: {
  selectedScopes: string[];
  onToggleScope: (scopeId: string) => void;
  onSelectAllRead: () => void;
  onSelectAllWrite: () => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>{t('sweep.settings.apiKeys.permissionsLabel')}</Label>
        <div className="flex gap-1">
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
      <div className="space-y-3">
        {(() => {
          const groups: { group: string; entities: typeof PERMISSION_ENTITIES[number][] }[] = [];
          for (const entity of PERMISSION_ENTITIES) {
            const last = groups[groups.length - 1];
            if (last && last.group === entity.group) {
              last.entities.push(entity);
            } else {
              groups.push({ group: entity.group, entities: [entity] });
            }
          }
          return groups.map(({ group, entities }) => {
            const groupLogo = GROUP_LOGOS[group];
            return (
              <div key={group} className="border rounded-md overflow-hidden">
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
                      <th className="text-center px-3 py-2 font-medium w-20 border-b border-border/40">{t('sweep.settings.apiKeys.table.read')}</th>
                      <th className="text-center px-3 py-2 font-medium w-20 border-b border-border/40">{t('sweep.settings.apiKeys.table.write')}</th>
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
                          {(['read', 'write'] as const).map((action) => {
                            const scope = entity.scopes.find((s) => s.id.endsWith(`:${action}`));
                            return (
                              <td key={action} className={cn('text-center px-3 py-2', cellBorder)}>
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
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          });
        })()}
      </div>
      {selectedScopes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('sweep.settings.apiKeys.selectedCount', { count: selectedScopes.length })}
        </p>
      )}
    </div>
  );
}

// Animated code preview component with typing effect (light mode colors)
const codeSnippets = [
  { indent: 0, text: 'for contact in contacts.data:', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 12, end: 14, color: 'text-purple-600' }] },
  { indent: 1, text: 'response = client.api.get(id=contact.id)', tokens: [{ start: 22, end: 25, color: 'text-blue-600' }, { start: 26, end: 28, color: 'text-cyan-700' }] },
  { indent: 1, text: "print('Found', len(response.data), 'records')", tokens: [{ start: 0, end: 5, color: 'text-blue-600' }, { start: 6, end: 13, color: 'text-emerald-600' }, { start: 15, end: 18, color: 'text-blue-600' }, { start: 35, end: 44, color: 'text-emerald-600' }] },
  { indent: 1, text: 'if len(response.data) != 0:', tokens: [{ start: 0, end: 2, color: 'text-purple-600' }, { start: 3, end: 6, color: 'text-blue-600' }, { start: 25, end: 26, color: 'text-rose-600' }] },
  { indent: 2, text: "created = response.data[0]['created_at']", tokens: [{ start: 24, end: 25, color: 'text-rose-600' }, { start: 27, end: 39, color: 'text-emerald-600' }] },
  { indent: 2, text: "updated = datetime.strptime(created, '%Y-%m-%d')", tokens: [{ start: 19, end: 27, color: 'text-blue-600' }, { start: 37, end: 47, color: 'text-emerald-600' }] },
  { indent: 2, text: 'today = datetime.now()', tokens: [{ start: 17, end: 20, color: 'text-blue-600' }] },
  { indent: 2, text: 'diff = (today - updated).days', tokens: [] },
  { indent: 2, text: 'if diff < threshold:', tokens: [{ start: 0, end: 2, color: 'text-purple-600' }] },
  { indent: 3, text: "print(contact.name, 'updated', threshold)", tokens: [{ start: 0, end: 5, color: 'text-blue-600' }, { start: 20, end: 29, color: 'text-emerald-600' }] },
  { indent: 3, text: 'total += len(response.data)', tokens: [{ start: 9, end: 12, color: 'text-blue-600' }] },
  { indent: 3, text: 'for item in response.data:', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 9, end: 11, color: 'text-purple-600' }] },
  { indent: 4, text: 'if item.metadata:', tokens: [{ start: 0, end: 2, color: 'text-purple-600' }] },
  { indent: 5, text: 'for key in item.metadata:', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 8, end: 10, color: 'text-purple-600' }] },
  { indent: 6, text: "value = key['value']", tokens: [{ start: 12, end: 19, color: 'text-emerald-600' }] },
  { indent: 6, text: 'records.add((value, item.id))', tokens: [{ start: 8, end: 11, color: 'text-blue-600' }] },
  { indent: 0, text: 'else:', tokens: [{ start: 0, end: 4, color: 'text-purple-600' }] },
  { indent: 1, text: "print(contact.name, 'no updates')", tokens: [{ start: 0, end: 5, color: 'text-blue-600' }, { start: 20, end: 32, color: 'text-emerald-600' }] },
  { indent: 0, text: '', tokens: [] },
  { indent: 0, text: '# Sync data with API', tokens: [{ start: 0, end: 20, color: 'text-slate-400' }] },
  { indent: 0, text: 'async def sync_contacts(api_key):', tokens: [{ start: 0, end: 5, color: 'text-purple-600' }, { start: 6, end: 9, color: 'text-purple-600' }, { start: 10, end: 23, color: 'text-blue-600' }] },
  { indent: 1, text: 'client = WeldSuite(api_key=api_key)', tokens: [{ start: 19, end: 26, color: 'text-cyan-700' }] },
  { indent: 1, text: 'contacts = await client.contacts.list()', tokens: [{ start: 11, end: 16, color: 'text-purple-600' }, { start: 33, end: 37, color: 'text-blue-600' }] },
  { indent: 1, text: 'for c in contacts:', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 6, end: 8, color: 'text-purple-600' }] },
  { indent: 2, text: 'yield c.to_dict()', tokens: [{ start: 0, end: 5, color: 'text-purple-600' }, { start: 8, end: 15, color: 'text-blue-600' }] },
  { indent: 0, text: '', tokens: [] },
  { indent: 0, text: '# Process batch orders', tokens: [{ start: 0, end: 22, color: 'text-slate-400' }] },
  { indent: 0, text: 'def process_orders(batch_size=100):', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 4, end: 18, color: 'text-blue-600' }, { start: 30, end: 33, color: 'text-rose-600' }] },
  { indent: 1, text: 'orders = api.orders.fetch(limit=batch_size)', tokens: [{ start: 20, end: 25, color: 'text-blue-600' }] },
  { indent: 1, text: 'for order in orders:', tokens: [{ start: 0, end: 3, color: 'text-purple-600' }, { start: 10, end: 12, color: 'text-purple-600' }] },
  { indent: 2, text: 'if order.status == "pending":', tokens: [{ start: 0, end: 2, color: 'text-purple-600' }, { start: 19, end: 28, color: 'text-emerald-600' }] },
  { indent: 3, text: 'order.process()', tokens: [{ start: 6, end: 13, color: 'text-blue-600' }] },
  { indent: 3, text: "logger.info(f'Processed {order.id}')", tokens: [{ start: 7, end: 11, color: 'text-blue-600' }, { start: 12, end: 35, color: 'text-emerald-600' }] },
];

function AnimatedCodePreview() {
  // Start with some pre-filled lines so it doesn't begin empty
  const initialLines = codeSnippets.slice(0, 10);

  // Store animation state in React state to ensure consistent rendering
  const [animState, setAnimState] = React.useState({
    lines: initialLines,
    lineIndex: 10,
    charIndex: 0,
    isPaused: false,
  });

  const containerRef = React.useRef<HTMLDivElement>(null);
  const timingRef = React.useRef({
    frameId: null as number | null,
    lastTime: 0,
    linesInBurst: 0,
    pauseUntil: 0,
  });

  React.useEffect(() => {
    let isRunning = true;
    const timing = timingRef.current;
    timing.lastTime = performance.now();

    const charDelay = 30;
    const linesPerBurst = 5 + Math.floor(Math.random() * 3); // 5-7 lines per burst
    const pauseDuration = 3000; // 3s pause

    const tick = () => {
      if (!isRunning) return;

      const now = performance.now();

      // Check if we're in a pause
      if (timing.pauseUntil > now) {
        timing.frameId = requestAnimationFrame(tick);
        return;
      }

      if (now - timing.lastTime >= charDelay) {
        timing.lastTime = now;

        // Use functional setState to ensure atomic updates based on prev state
        setAnimState(prev => {
          const currentSnippet = codeSnippets[prev.lineIndex % codeSnippets.length];

          if (prev.charIndex < currentSnippet.text.length) {
            // Still typing current line
            return { ...prev, charIndex: prev.charIndex + 1, isPaused: false };
          } else {
            // Line complete - add to completed lines and start new line
            let newLines = [...prev.lines, { ...currentSnippet }];
            if (newLines.length > 16) {
              newLines = newLines.slice(-16);
            }

            // Track lines in current burst
            timing.linesInBurst += 1;

            // Check if we should pause after this burst
            const shouldPause = timing.linesInBurst >= linesPerBurst;
            if (shouldPause) {
              timing.linesInBurst = 0;
              timing.pauseUntil = now + pauseDuration;
            }

            // Schedule scroll after state update
            requestAnimationFrame(() => {
              if (containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
              }
            });

            return {
              lines: newLines,
              lineIndex: prev.lineIndex + 1,
              charIndex: 0,
              isPaused: shouldPause,
            };
          }
        });
      }

      timing.frameId = requestAnimationFrame(tick);
    };

    timing.frameId = requestAnimationFrame(tick);

    return () => {
      isRunning = false;
      if (timing.frameId !== null) {
        cancelAnimationFrame(timing.frameId);
        timing.frameId = null;
      }
    };
  }, []);

  const renderTextWithColors = (text: string, tokens: { start: number; end: number; color: string }[], maxLen?: number) => {
    const displayText = maxLen !== undefined ? text.slice(0, maxLen) : text;
    if (tokens.length === 0) {
      return <span className="text-slate-800">{displayText}</span>;
    }

    const result: React.ReactNode[] = [];
    let lastIndex = 0;

    const sortedTokens = [...tokens].sort((a, b) => a.start - b.start);

    for (const token of sortedTokens) {
      if (token.start >= displayText.length) break;

      // Add plain text before this token
      if (lastIndex < token.start) {
        result.push(
          <span key={`plain-${lastIndex}`} className="text-slate-800">
            {displayText.slice(lastIndex, token.start)}
          </span>
        );
        lastIndex = token.start;
      }

      // Add the colored token text
      const tokenEnd = Math.min(token.end, displayText.length);
      if (lastIndex < tokenEnd) {
        result.push(
          <span key={`token-${token.start}`} className={token.color}>
            {displayText.slice(lastIndex, tokenEnd)}
          </span>
        );
        lastIndex = tokenEnd;
      }
    }

    // Add remaining plain text after all tokens
    if (lastIndex < displayText.length) {
      result.push(
        <span key={`plain-${lastIndex}`} className="text-slate-800">
          {displayText.slice(lastIndex)}
        </span>
      );
    }

    return result;
  };

  // Read from state (not ref) for consistent rendering
  const currentSnippet = codeSnippets[animState.lineIndex % codeSnippets.length];

  return (
    <div className="flex-1 hidden lg:flex flex-col bg-slate-50 border-l overflow-hidden h-[427px]">
      <div
        ref={containerRef}
        className="flex-1 p-5 font-mono text-[13px] font-medium leading-relaxed overflow-hidden"
      >
        {animState.lines.map((line, idx) => (
          <div key={`line-${idx}-${line.text.slice(0, 10)}`} style={{ paddingLeft: `${line.indent * 16}px` }}>
            {renderTextWithColors(line.text, line.tokens)}
          </div>
        ))}
        {/* Current typing line */}
        <div style={{ paddingLeft: `${currentSnippet.indent * 16}px` }}>
          {renderTextWithColors(currentSnippet.text, currentSnippet.tokens, animState.charIndex)}
          <span className="inline-block w-2 h-4 bg-slate-500 animate-pulse ml-0.5 align-middle" />
        </div>
      </div>
    </div>
  );
}

export function ApiKeysSection() {
  const t = useTranslations()
  const [error, setError] = React.useState<string | null>(null)
  const [createdKey, setCreatedKey] = React.useState<WorkspaceApiKey | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)
  const [hasApiAccess, setHasApiAccess] = React.useState<boolean | null>(null)
  const [showPricingDialog, setShowPricingDialog] = React.useState(false)
  const { getClient } = useAppApiClient()

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
    const q = searchQuery.trim().toLowerCase()
    return apiKeys.filter((k) => {
      for (const f of activeFilters) {
        if (!f.value) continue
        if (f.field === 'usage') {
          const used = !!k.lastUsedAt
          if (f.value === 'used' && !used) return false
          if (f.value === 'unused' && used) return false
        }
      }
      if (q) {
        const haystack = [k.name, k.description, k.keyPrefix].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [apiKeys, activeFilters, searchQuery])

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

  // Select all scopes
  const selectAll = (setScopeList: (scopes: string[]) => void) => {
    setScopeList([...ALL_SCOPES])
  }

  // Clear all scopes
  const clearAll = (setScopeList: (scopes: string[]) => void) => {
    setScopeList([])
  }

  // Load subscription data to check API access
  React.useEffect(() => {
    async function checkApiAccess() {
      try {
        const client = await getClient()
        // app-api GET /api/billing/plans-page — `{ data }` envelope.
        const plansResult = await client.get<{ data?: { plans: any[]; subscription: any } }>('/billing/plans-page')
        if (plansResult.data?.subscription) {
          const currentPlan = plansResult.data.plans?.find(
            (p: any) => p.id === plansResult.data!.subscription!.planId
          )
          setHasApiAccess(currentPlan?.hasApiAccess ?? false)
        } else {
          setHasApiAccess(false)
        }
      } catch {
        setHasApiAccess(false)
      }
    }
    checkApiAccess()
  }, [getClient])

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
        setCreatedKey(result.data)
        setKeyName("")
        setKeyDescription("")
        setSelectedScopes([])
        setCreateDialogOpen(false)
      } else {
        setError((result as any).error || t('sweep.settings.apiKeys.errors.createFailed'))
      }
    } catch (err: any) {
      console.error("Failed to create API key:", err)
      setError(err?.message || t('sweep.settings.apiKeys.errors.createFailed'))
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
        setError((result as any).error || t('sweep.settings.apiKeys.errors.updateFailed'))
      }
    } catch (err: any) {
      console.error("Failed to update API key:", err)
      setError(err?.message || t('sweep.settings.apiKeys.errors.updateFailed'))
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
    } catch (err: any) {
      console.error("Failed to revoke API key:", err)
      setError(err?.message || t('sweep.settings.apiKeys.errors.revokeFailed'))
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

  // While the subscription check is in flight (`null`), we don't yet know
  // whether to show the keys manager or the upgrade prompt. Render a
  // lightweight placeholder instead of the full manager — otherwise the
  // "Generate Key" button (and its dialog) mount during this window and then
  // get torn out from under the user the moment the check resolves to "no API
  // access", flashing the UI and dropping any interaction that lands in the gap.
  if (hasApiAccess === null) {
    return (
      <div className="space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.apiKeys.title')}</h1>
          <p className="text-muted-foreground">{t('sweep.settings.apiKeys.description')}</p>
        </div>
        <div className="border rounded-lg p-8 text-center text-muted-foreground">
          {t('sweep.settings.apiKeys.loadingKeys')}
        </div>
      </div>
    )
  }

  // Show upgrade prompt if user doesn't have API access
  if (hasApiAccess === false) {
    return (
      <div className="space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.apiKeys.title')}</h1>
          <p className="text-muted-foreground">{t('sweep.settings.apiKeys.description')}</p>
        </div>

        <Card className="overflow-hidden py-0 rounded-xl">
          <CardContent className="p-0">
            <div className="flex flex-col lg:flex-row min-h-[427px]">
              {/* Left side - Text content */}
              <div className="flex-1 flex flex-col pl-6 py-6">
                {/* Title and description at top */}
                <div>
                  <h2 className="text-xl font-[550] tracking-tight">
                    {t('sweep.settings.apiKeys.upgradePromo.heading')}<br />
                    <span className="text-muted-foreground">{t('sweep.settings.apiKeys.upgradePromo.subheadingLine1')}<br />
                    {t('sweep.settings.apiKeys.upgradePromo.subheadingLine2')}</span>
                  </h2>
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Buttons at bottom */}
                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => setShowPricingDialog(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="!h-[18px] !w-[18px]">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15 11.25-3-3m0 0-3 3m3-3v7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                    </svg>
                    {t('sweep.settings.apiKeys.upgradePromo.upgradeButton')}
                  </Button>
                  <Button variant="outline" className="rounded-lg">
                    {t('sweep.settings.apiKeys.upgradePromo.learnMore')}
                  </Button>
                </div>
              </div>

              {/* Right side - Code preview */}
              <AnimatedCodePreview />
            </div>
          </CardContent>
        </Card>

        <PricingDialog
          open={showPricingDialog}
          onOpenChange={setShowPricingDialog}
          excludePlans={['business']}
          highlightPlan="scale"
          hideHeaderBar
          featureHighlight={{
            feature: t('sweep.settings.apiKeys.upgradePromo.featureName'),
            description: t('sweep.settings.apiKeys.upgradePromo.featureDescription'),
            plan: 'Pro',
          }}
        />
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
            <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('sweep.settings.apiKeys.createDialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('sweep.settings.apiKeys.createDialog.description')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="name">{t('sweep.settings.apiKeys.nameLabel')}</Label>
                  <Input
                    id="name"
                    placeholder={t('sweep.settings.apiKeys.namePlaceholder')}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
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
                  onSelectAll={() => selectAll(setSelectedScopes)}
                  onClearAll={() => clearAll(setSelectedScopes)}
                />
              </div>

              {error && createDialogOpen && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <DialogFooter>
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
          <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t('sweep.settings.apiKeys.editDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('sweep.settings.apiKeys.editDialog.description')}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-name">{t('sweep.settings.apiKeys.nameLabel')}</Label>
                <Input
                  id="edit-name"
                  placeholder={t('sweep.settings.apiKeys.namePlaceholder')}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
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
                onSelectAll={() => selectAll(setEditScopes)}
                onClearAll={() => clearAll(setEditScopes)}
              />
            </div>

            {error && editDialogOpen && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
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

        {loading ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            {t('sweep.settings.apiKeys.loadingKeys')}
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            <p>{t('sweep.settings.apiKeys.emptyState.title')}</p>
            <p className="text-sm mt-1">{t('sweep.settings.apiKeys.emptyState.subtitle')}</p>
          </div>
        ) : (
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
