
import * as React from 'react';
import { useState } from 'react';
import { useRouter, usePathname, Link } from '@/lib/router';
import {
  Inbox,
  Trash2,
  Star,
  Mail,
  SendHorizontal,
  File,
  Clock,
  Calendar,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Plus,
  Archive,
  Info,
  Check,
  X,
  PencilLine,
  MoreVertical,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { MenuGroupProps, EmailAccount } from '@/components/app-sidebar-layout';
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Slider } from '@weldsuite/ui/components/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';
import { mailApi } from '../lib/api-client';
import {
  useUserPreferences,
  useUpdateMailDefaultAccount,
} from '@/hooks/queries/use-settings-queries';
import { useAppApi } from '@/lib/api/use-app-api';
import type { MailLabelRow as MailLabel } from '@weldsuite/app-api-client/domains/mail-labels';
import { isSystemLabel } from '../lib/label-config';
import { getLabelColor } from '@/components/shared/conversation-list';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';

function KeywordTagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const tags = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (tags.includes(trimmed)) {
      setInputValue('');
      return;
    }
    const newTags = [...tags, trimmed];
    onChange(newTags.join(', '));
    setInputValue('');
  };

  const removeTag = (index: number) => {
    const newTags = tags.filter((_, i) => i !== index);
    onChange(newTags.join(', '));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ',' || e.key === 'Enter') {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.includes(',')) {
      const parts = val.split(',');
      parts.slice(0, -1).forEach((p) => addTag(p));
      setInputValue(parts[parts.length - 1]);
    } else {
      setInputValue(val);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[36px] px-2.5 py-1.5 rounded-md border border-input bg-background cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <Badge
          key={i}
          variant="secondary"
          className="text-xs px-2 py-0.5 gap-1 flex-shrink-0 rounded-sm"
        >
          {tag}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(i);
            }}
            className="ml-0.5 hover:text-foreground h-auto w-auto p-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      ))}
      <input
        ref={inputRef}
        value={inputValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (inputValue.trim()) addTag(inputValue); }}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
      />
    </div>
  );
}

const LABEL_COLORS = [
  { key: 'colorRed', value: '#EF4444' },
  { key: 'colorOrange', value: '#F97316' },
  { key: 'colorYellow', value: '#EAB308' },
  { key: 'colorGreen', value: '#22C55E' },
  { key: 'colorTeal', value: '#14B8A6' },
  { key: 'colorBlue', value: '#3B82F6' },
  { key: 'colorPurple', value: '#8B5CF6' },
  { key: 'colorPink', value: '#EC4899' },
] as const;

export function useMailSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
  dialogs: React.ReactNode;
  emailAccountProps: {
    currentEmailAccount: EmailAccount | null;
    emailAccounts: EmailAccount[];
    onEmailAccountSwitch: (accountId: string) => void;
    onEmailAccountAdd: () => void;
    defaultEmailAccountId: string | null;
    onSetDefaultEmailAccount: (accountId: string | null) => void;
    setDefaultLabel: string;
    defaultLabel: string;
  };
} {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();

  const [showCreateLabelDialog, setShowCreateLabelDialog] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[5].value);
  const [isCreatingLabel, setIsCreatingLabel] = useState(false);
  const [localLabels, setLocalLabels] = useState<MailTypes.Label[]>([]);
  // Edit label dialog state
  const [showEditLabelDialog, setShowEditLabelDialog] = useState(false);
  const [editingLabel, setEditingLabel] = useState<MailTypes.Label | null>(null);
  const [editLabelName, setEditLabelName] = useState('');
  const [editLabelColor, setEditLabelColor] = useState('');
  const [editAiEnabled, setEditAiEnabled] = useState(false);
  const [editAiKeywords, setEditAiKeywords] = useState('');
  const [editAiDescription, setEditAiDescription] = useState('');
  const [editAiConfidence, setEditAiConfidence] = useState(70);
  const [isUpdatingLabel, setIsUpdatingLabel] = useState(false);

  // Map label name (lowercase) → accountIds that own this label (for unified mode cross-account check)
  const [labelAccountMap, setLabelAccountMap] = useState<Record<string, string[]>>({});
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});
  const [showMore, setShowMore] = useState(false);

  // Agent Auto-Labeling settings
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiDescription, setAiDescription] = useState('');
  const [aiConfidence, setAiConfidence] = useState(70);
  // Agent Auto-Draft settings
  const [aiAutoDraft, setAiAutoDraft] = useState(false);
  const [aiDraftTone, setAiDraftTone] = useState<'professional' | 'friendly' | 'casual'>('professional');
  const [aiDraftLength, setAiDraftLength] = useState<'short' | 'medium' | 'detailed'>('medium');
  const [aiDraftInstructions, setAiDraftInstructions] = useState('');

  // Local state for email accounts
  const [localEmailAccounts, setLocalEmailAccounts] = useState<MailTypes.EmailAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);

  // User-pinned default landing account (personal, server-backed per user).
  const { data: userPreferences } = useUserPreferences();
  const updateDefaultAccount = useUpdateMailDefaultAccount();
  const defaultEmailAccountId = userPreferences?.uiPreferences?.mailDefaultAccountId ?? null;

  const handleSetDefaultAccount = React.useCallback(
    (accountId: string | null) => {
      // Toggle off when the user re-selects the current default.
      const next = accountId && accountId !== defaultEmailAccountId ? accountId : null;
      updateDefaultAccount.mutate(next);
    },
    [defaultEmailAccountId, updateDefaultAccount],
  );

  // Detect unified mode
  const isUnified = pathname?.startsWith('/weldmail/unified') ?? false;

  // Known static mail routes (not accountIds)
  const STATIC_MAIL_ROUTES = new Set([
    'inbox', 'search', 'scheduled', 'snoozed', 'settings', 'setup',
    'domains', 'ai', 'unified', 'stats',
  ]);

  // Extract accountId from pathname (not present in unified mode or static routes)
  const accountIdMatch = !isUnified ? pathname?.match(/^\/weldmail\/([^\/]+)/) : null;
  const rawAccountId = accountIdMatch?.[1];
  const accountId = rawAccountId && !STATIC_MAIL_ROUTES.has(rawAccountId)
    ? rawAccountId
    : undefined;

  // For static routes like /weldmail/inbox, resolve the default/first account
  const resolvedAccountId = accountId || (localEmailAccounts.length > 0
    ? (localEmailAccounts.find((a) => a.isDefault)?.id || localEmailAccounts[0]?.id)
    : undefined);

  const { mailAccounts, mailLabels } = useAppApi();

  // Fetch email accounts via app-api
  const fetchAccounts = React.useCallback(() => {
    if (!isActive) return;
    mailAccounts.list()
      .then((result) => {
        if (result.data) {
          setLocalEmailAccounts(result.data as any);
        }
      })
      .catch(() => {})
      .finally(() => setAccountsLoading(false));
  }, [isActive, mailAccounts]);

  React.useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Re-fetch when an account is created
  React.useEffect(() => {
    const handler = () => fetchAccounts();
    window.addEventListener('mail-accounts-changed', handler);
    return () => window.removeEventListener('mail-accounts-changed', handler);
  }, [fetchAccounts]);

  // Fetch labels via core-api
  // Unified mode: no accountId → server aggregates across all accounts
  // Per-account: pass accountId → scoped to that account
  React.useEffect(() => {
    if (!isActive) return;

    const mapLabels = (rows: MailLabel[]): MailTypes.Label[] =>
      rows
        .filter((l) => !isSystemLabel(l.name.toLowerCase()))
        .map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          count: l.messageCount || 0,
          aiEnabled: l.aiEnabled,
          aiKeywords: l.aiKeywords,
          aiDescription: l.aiDescription,
        }));

    if (isUnified) {
      // Unified inbox: fetch all labels across accounts (server-side aggregation)
      mailLabels.list({})
        .then((result) => setLocalLabels(mapLabels(result.data)))
        .catch((error) => {
          console.error('Failed to fetch unified labels:', error);
        });
      return;
    }

    if (!resolvedAccountId) {
      setLocalLabels([]);
      return;
    }

    mailLabels.list({ accountId: resolvedAccountId })
      .then((result) => setLocalLabels(mapLabels(result.data)))
      .catch((error) => {
        console.error('Failed to fetch labels:', error);
      });
  }, [isActive, resolvedAccountId, isUnified, mailLabels]);

  // Fetch label-based badge counts via stats endpoint
  const fetchStats = React.useCallback(() => {
    if (!isActive) {
      setFolderCounts({});
      return;
    }

    const applyStats = (data: any) => {
      const counts: Record<string, number> = {};
      if (data.inboxUnread > 0) counts['inbox'] = data.inboxUnread;
      if (data.starredUnread > 0) counts['starred'] = data.starredUnread;
      if (data.sentUnread > 0) counts['sent'] = data.sentUnread;
      if (data.drafts > 0) counts['drafts'] = data.drafts;
      if (data.scheduled > 0) counts['scheduled'] = data.scheduled;
      if (data.snoozed > 0) counts['snoozed'] = data.snoozed;
      if (data.importantUnread > 0) counts['important'] = data.importantUnread;
      if (data.archiveUnread > 0) counts['archive'] = data.archiveUnread;
      if (data.spam > 0) counts['spam'] = data.spam;
      if (data.trashUnread > 0) counts['trash'] = data.trashUnread;
      setFolderCounts(counts);
    };

    if (isUnified && localEmailAccounts.length > 0) {
      Promise.all(localEmailAccounts.map((acc) => mailApi.messages.stats(acc.id)))
        .then((results) => {
          const aggregated: Record<string, number> = {};
          const keys = ['inboxUnread', 'starredUnread', 'sentUnread', 'drafts', 'scheduled', 'snoozed', 'importantUnread', 'archiveUnread', 'spam', 'trashUnread'];
          for (const result of results) {
            if (result.success && result.data) {
              for (const key of keys) {
                aggregated[key] = (aggregated[key] || 0) + ((result.data as any)[key] || 0);
              }
            }
          }
          applyStats(aggregated);
        })
        .catch(() => {});
    } else if (resolvedAccountId) {
      mailApi.messages
        .stats(resolvedAccountId)
        .then((result) => {
          if (result.success && result.data) {
            applyStats(result.data);
          }
        })
        .catch(() => {});
    } else {
      setFolderCounts({});
    }
  }, [isActive, resolvedAccountId, isUnified, localEmailAccounts]);

  // Initial fetch + re-fetch on dependency changes
  React.useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Re-fetch stats when messages change (read, star, trash, label, etc.)
  React.useEffect(() => {
    const handler = () => fetchStats();
    window.addEventListener('mail-messages-changed', handler);
    return () => window.removeEventListener('mail-messages-changed', handler);
  }, [fetchStats]);

  const handleCreateLabel = async () => {
    const name = newLabelName.trim();
    if (!name) {
      toast.error(t.mail.sidebar.labelNameEmpty);
      return;
    }
    if (localLabels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t.mail.sidebar.labelNameExists);
      return;
    }
    if (!resolvedAccountId) {
      toast.error(t.mail.sidebar.noEmailAccountSelected);
      return;
    }

    setIsCreatingLabel(true);
    const keywordsArray =
      aiEnabled && aiKeywords.trim()
        ? aiKeywords
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined;

    try {
      const result = await mailLabels.create({
        accountId: resolvedAccountId!,
        name,
        color: newLabelColor,
        aiEnabled: aiEnabled || undefined,
        aiKeywords: keywordsArray,
        aiDescription: aiEnabled && aiDescription.trim() ? aiDescription.trim() : undefined,
        aiConfidence: aiEnabled ? aiConfidence : undefined,
      });

      const created = result.data;
      const newLabel: MailTypes.Label = {
        id: created.id,
        name: created.name,
        color: created.color,
        count: created.messageCount || 0,
        aiEnabled: created.aiEnabled,
        aiKeywords: created.aiKeywords,
        aiDescription: created.aiDescription,
        aiConfidence: created.aiConfidence,
      };
      setLocalLabels((prev) => [...prev, newLabel]);
      toast.success(t.mail.sidebar.labelCreated);
      resetLabelDialog();
    } catch (err: any) {
      toast.error(err?.message || t.mail.sidebar.failedToCreateLabel);
    }
    setIsCreatingLabel(false);
  };

  const resetLabelDialog = () => {
    setNewLabelName('');
    setNewLabelColor(LABEL_COLORS[5].value);
    setAiEnabled(false);
    setAiKeywords('');
    setAiDescription('');
    setAiConfidence(70);
    setAiAutoDraft(false);
    setAiDraftTone('professional');
    setAiDraftLength('medium');
    setAiDraftInstructions('');
    setShowCreateLabelDialog(false);
  };

  const handleOpenEditLabel = (label: MailTypes.Label) => {
    setEditingLabel(label);
    setEditLabelName(label.name);
    setEditLabelColor(label.color || LABEL_COLORS[5].value);
    setEditAiEnabled(label.aiEnabled || false);
    setEditAiKeywords(label.aiKeywords?.join(', ') || '');
    setEditAiDescription(label.aiDescription || '');
    setEditAiConfidence(label.aiConfidence || 70);
    setShowEditLabelDialog(true);
  };

  const resetEditLabelDialog = () => {
    setEditingLabel(null);
    setEditLabelName('');
    setEditLabelColor(LABEL_COLORS[5].value);
    setEditAiEnabled(false);
    setEditAiKeywords('');
    setEditAiDescription('');
    setEditAiConfidence(70);
    setShowEditLabelDialog(false);
  };

  const handleUpdateLabel = async () => {
    if (!editingLabel?.id) return;
    const name = editLabelName.trim();
    if (!name) {
      toast.error(t.mail.sidebar.labelNameEmpty);
      return;
    }
    if (localLabels.some((l) => l.id !== editingLabel.id && l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t.mail.sidebar.labelNameExists);
      return;
    }

    setIsUpdatingLabel(true);
    const keywordsArray = editAiEnabled && editAiKeywords.trim()
      ? editAiKeywords.split(',').map((k) => k.trim()).filter(Boolean)
      : undefined;

    try {
      const result = await mailLabels.update(editingLabel.id, {
        name,
        color: editLabelColor,
        aiEnabled: editAiEnabled || undefined,
        aiKeywords: keywordsArray,
        aiDescription: editAiEnabled && editAiDescription.trim() ? editAiDescription.trim() : undefined,
        aiConfidence: editAiEnabled ? editAiConfidence : undefined,
      });

      const updated = result.data;
      setLocalLabels((prev) =>
        prev.map((l) =>
          l.id === editingLabel.id
            ? {
                ...l,
                name: updated.name,
                color: updated.color,
                count: updated.messageCount || 0,
                aiEnabled: updated.aiEnabled,
                aiKeywords: updated.aiKeywords,
                aiDescription: updated.aiDescription,
                aiConfidence: updated.aiConfidence,
              }
            : l
        )
      );
      toast.success(t.mail.sidebar.labelUpdated);
      resetEditLabelDialog();
    } catch (err: any) {
      toast.error(err?.message || t.mail.sidebar.failedToUpdateLabel);
    }
    setIsUpdatingLabel(false);
  };

  // Handle account switching
  const handleAccountSwitch = (newAccountId: string) => {
    if (newAccountId === 'unified') {
      router.push('/weldmail/unified/inbox');
    } else {
      router.push(`/weldmail/${newAccountId}/inbox`);
    }
  };

  const handleAccountAdd = () => {
    router.push('/settings/apps/weldmail');
  };

  // Default empty result for non-active
  const emptyResult = {
    menuGroups: [],
    dialogs: null,
    emailAccountProps: {
      currentEmailAccount: null as EmailAccount | null,
      emailAccounts: [] as EmailAccount[],
      onEmailAccountSwitch: handleAccountSwitch,
      onEmailAccountAdd: handleAccountAdd,
      defaultEmailAccountId,
      onSetDefaultEmailAccount: handleSetDefaultAccount,
      setDefaultLabel: t.mail.sidebar.setAsDefault,
      defaultLabel: t.mail.sidebar.defaultAccount,
    },
  };

  if (!isActive) {
    return emptyResult;
  }

  const hasEmailAccounts = localEmailAccounts.length > 0;
  const currentAccount = localEmailAccounts.find((acc) => acc.id === resolvedAccountId);

  const getMailUrl = (path: string) => {
    if (isUnified) return `/weldmail/unified${path}`;
    if (!resolvedAccountId) return '#';
    return `/weldmail/${resolvedAccountId}${path}`;
  };

  const importantMailboxItems = [
    { title: t.mail.sidebar.inbox, href: getMailUrl('/inbox'), icon: Inbox, count: folderCounts['inbox'] || 0 },
    { title: t.mail.sidebar.starred, href: getMailUrl('/starred'), icon: Star, count: folderCounts['starred'] || 0 },
    { title: t.mail.sidebar.sent, href: getMailUrl('/sent'), icon: SendHorizontal, iconClassName: 'opacity-80', count: folderCounts['sent'] || 0 },
    { title: t.mail.sidebar.drafts, href: getMailUrl('/drafts'), icon: File, count: folderCounts['drafts'] || 0 },
  ];

  const lessMailboxItems = [
    { title: t.mail.sidebar.scheduled, href: getMailUrl('/scheduled'), icon: Calendar, count: folderCounts['scheduled'] || 0 },
    { title: t.mail.sidebar.snoozed, href: getMailUrl('/snoozed'), icon: Clock, count: folderCounts['snoozed'] || 0 },
    { title: t.mail.sidebar.important, href: getMailUrl('/important'), icon: AlertCircle, count: folderCounts['important'] || 0 },
    { title: t.mail.sidebar.allMail, href: getMailUrl('/all'), icon: Mail, count: folderCounts['all'] || 0 },
    { title: t.mail.sidebar.archive, href: getMailUrl('/archive'), icon: Archive, count: folderCounts['archive'] || 0 },
    { title: t.mail.sidebar.spam, href: getMailUrl('/spam'), icon: AlertCircle, count: folderCounts['spam'] || 0 },
    { title: t.mail.sidebar.trash, href: getMailUrl('/trash'), icon: Trash2, count: folderCounts['trash'] || 0 },
  ];


  const mailboxGroup: MenuGroupProps = {
    group: t.mail.sidebar.mailboxes,
    customContent: (
      <div key={`mailbox-content-${resolvedAccountId || 'none'}`} suppressHydrationWarning>
        {accountsLoading ? (
          <div className="px-3 py-1.5 space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : !hasEmailAccounts ? (
          <div className="px-3 py-4 space-y-3">
            <p className="text-sm text-muted-foreground">{t.mail.sidebar.noEmailAccountConnected}</p>
          </div>
        ) : (
          <SidebarMenu key={resolvedAccountId || 'no-account'}>
            {importantMailboxItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || (pathname?.startsWith(item.href + '/') ?? false);
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={isActive}>
                    <Link href={item.href}>
                      <Icon className={`h-4 w-4 ${(item as any).iconClassName || ''}`} />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  {item.count > 0 && <SidebarMenuBadge>{item.count}</SidebarMenuBadge>}
                </SidebarMenuItem>
              );
            })}
            {showMore &&
              lessMailboxItems.map((item) => {
                const Icon = item.icon;
                const isItemActive = pathname === item.href || (pathname?.startsWith(item.href + '/') ?? false);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isItemActive}>
                      <Link href={item.href}>
                        <Icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.count > 0 && <SidebarMenuBadge>{item.count}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                );
              })}
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setShowMore(!showMore)}>
                {showMore ? (
                  <ChevronUp className="h-4 w-4 text-gray-500" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                )}
                <span>{showMore ? t.mail.sidebar.less : t.mail.sidebar.more}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </div>
    ),
    items: [],
  };

  const labelsGroup: MenuGroupProps = {
    group: t.mail.sidebar.labels,
    onAdd: () => setShowCreateLabelDialog(true),
    customContent: (
      <div key={`labels-content-${resolvedAccountId || 'none'}`}>
        <SidebarMenu>
          {localLabels.map((label) => {
            const labelHref = getMailUrl(`/${encodeURIComponent(label.name.toLowerCase())}`);
            const isLabelActive = pathname === labelHref;
            const color = getLabelColor(label.name, label.color ? { [label.name]: label.color } : undefined);
            const labelKey = label.name.toLowerCase();
            // In unified mode, pass accountIds that own this label; in single-account mode, pass the current account
            const dragAccountIds = isUnified
              ? labelAccountMap[labelKey] || []
              : resolvedAccountId ? [resolvedAccountId] : [];
            return (
              <SidebarMenuItem key={label.name} className="group/label relative">
                {/* The 3-dots lives in an absolutely-positioned sibling, so
                    hovering it moves the cursor off this link. Drive the row
                    highlight off the row group instead so it stays lit while the
                    button (and its own hover patch) is being used. */}
                <SidebarMenuButton
                  asChild
                  isActive={isLabelActive}
                  className="transition-[width,height] group-hover/label:bg-sidebar-accent group-hover/label:text-sidebar-accent-foreground group-hover/label:pr-7 group-has-[[data-state=open]]/label:bg-sidebar-accent group-has-[[data-state=open]]/label:text-sidebar-accent-foreground group-has-[[data-state=open]]/label:pr-7"
                >
                  <Link
                    href={labelHref}
                    draggable
                    onDragStart={(e) => {
                      const data = JSON.stringify({ name: label.name, accountIds: dragAccountIds });
                      e.dataTransfer.setData('application/x-mail-label', data);
                      e.dataTransfer.effectAllowed = 'copy';
                      const badge = document.createElement('span');
                      badge.textContent = label.name;
                      badge.style.cssText = `padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;background:${color};color:#fff;position:fixed;top:-100px;`;
                      document.body.appendChild(badge);
                      e.dataTransfer.setDragImage(badge, badge.offsetWidth / 2, badge.offsetHeight / 2);
                      requestAnimationFrame(() => document.body.removeChild(badge));
                    }}
                  >
                    <span
                      className="px-2 py-0.5 rounded text-[12px] font-medium"
                      style={{
                        backgroundColor: `${color}15`,
                        color: color,
                      }}
                    >
                      {label.name}
                    </span>
                    {label.count > 0 && (
                      <span className="ml-auto text-xs font-mono text-muted-foreground group-hover/label:hidden group-has-[[data-state=open]]/label:hidden">{label.count}</span>
                    )}
                  </Link>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 hover:bg-black/[0.05] dark:hover:bg-black/20 data-[state=open]:bg-black/[0.05] dark:data-[state=open]:bg-black/20 rounded-md hidden group-hover/label:flex data-[state=open]:flex"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    <DropdownMenuItem onClick={() => handleOpenEditLabel(label)}>
                      <PencilLine className="h-3.5 w-3.5 mr-0.5" />
                      {t.mail.sidebar.edit}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        // TODO: delete label via core-api
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-0.5" />
                      {t.mail.sidebar.delete}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            );
          })}
          {localLabels.length === 0 && (
            <div className="px-2 py-2">
              <Button
                variant="ghost"
                onClick={() => setShowCreateLabelDialog(true)}
                className="w-full h-9 border border-dashed border-muted-foreground/25 rounded-md text-xs text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                {t.mail.sidebar.addLabel}
              </Button>
            </div>
          )}
        </SidebarMenu>
      </div>
    ),
    items: [],
  };

  const menuGroups: MenuGroupProps[] = [
    mailboxGroup,
    ...(hasEmailAccounts ? [labelsGroup] : []),
  ];

  // Convert accounts for AppSidebarLayout — add "All Accounts" when 2+ accounts exist
  const allAccountsEntry: EmailAccount = {
    id: 'unified',
    email: t.mail.sidebar.allAccounts,
    displayName: t.mail.sidebar.allAccounts,
  };

  const userMenuAccounts: EmailAccount[] = [
    ...(localEmailAccounts.length >= 2 ? [allAccountsEntry] : []),
    ...localEmailAccounts.map((acc) => ({
      id: acc.id,
      email: acc.email,
      displayName: acc.displayName,
    })),
  ];

  const currentUserMenuAccount: EmailAccount | null = isUnified
    ? allAccountsEntry
    : currentAccount
      ? {
          id: currentAccount.id,
          email: currentAccount.email,
          displayName: currentAccount.displayName,
        }
      : null;

  const dialogs = (
    <>
    {/* Edit Label Dialog */}
    <Dialog open={showEditLabelDialog} onOpenChange={resetEditLabelDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.mail.sidebar.editLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="sidebar-edit-label-name">{t.mail.sidebar.labelName}</Label>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-9 h-9 rounded-md border border-input flex items-center justify-center flex-shrink-0 hover:bg-accent transition-colors"
                  >
                    <div className="w-5 h-5 rounded" style={{ backgroundColor: editLabelColor }} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div className="grid grid-cols-4 gap-1.5">
                    {LABEL_COLORS.map((color) => (
                      <Button
                        key={color.value}
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditLabelColor(color.value)}
                        className="w-8 h-8 rounded-md flex items-center justify-center hover:scale-110 transition-transform"
                        style={{ backgroundColor: color.value }}
                        title={t.mail.sidebar[color.key]}
                      >
                        {editLabelColor === color.value && (
                          <Check className="h-4 w-4 text-white drop-shadow-sm" strokeWidth={3} />
                        )}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Input
                id="sidebar-edit-label-name"
                placeholder={t.mail.sidebar.enterLabelName}
                value={editLabelName}
                onChange={(e) => setEditLabelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isUpdatingLabel) handleUpdateLabel();
                }}
                autoFocus
              />
            </div>
          </div>

          <div className="pt-4 mt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label className="flex items-center gap-2">
                  <img src="/assets/images/weldagent/logo-light.png" alt="AI" width={18} height={18} />
                  {t.mail.sidebar.agentAutoLabeling}
                </Label>
              </div>
              <Switch checked={editAiEnabled} onCheckedChange={setEditAiEnabled} />
            </div>

            <div className={`grid transition-all duration-300 ease-in-out ${editAiEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="space-y-4 pt-4 pb-2">
                  <div className="space-y-2">
                    <Label htmlFor="sidebar-edit-ai-keywords">{t.mail.sidebar.labelKeywords}</Label>
                    <KeywordTagInput
                      value={editAiKeywords}
                      onChange={setEditAiKeywords}
                      placeholder={t.mail.sidebar.typeAndPressComma}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sidebar-edit-ai-description">{t.mail.sidebar.labelAiDescription}</Label>
                    <Textarea
                      id="sidebar-edit-ai-description"
                      placeholder={t.mail.sidebar.applyToEmailsAbout}
                      value={editAiDescription}
                      onChange={(e) => setEditAiDescription(e.target.value)}
                      rows={3}
                      className="bg-background"
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t.mail.sidebar.labelMinConfidence}</Label>
                      <span className="text-sm font-medium tabular-nums">{editAiConfidence}%</span>
                    </div>
                    <Slider
                      value={[editAiConfidence]}
                      onValueChange={(value) => setEditAiConfidence(value[0])}
                      min={0}
                      max={100}
                      step={5}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={resetEditLabelDialog} disabled={isUpdatingLabel}>
            {t.mail.sidebar.cancel}
          </Button>
          <Button onClick={handleUpdateLabel} disabled={isUpdatingLabel}>
            {isUpdatingLabel ? t.mail.sidebar.saving : t.mail.sidebar.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Create Label Dialog */}
    <Dialog open={showCreateLabelDialog} onOpenChange={resetLabelDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.mail.sidebar.createLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="sidebar-label-name">{t.mail.sidebar.labelName}</Label>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-9 h-9 rounded-md border border-input flex items-center justify-center flex-shrink-0 hover:bg-accent transition-colors"
                  >
                    <div
                      className="w-5 h-5 rounded"
                      style={{ backgroundColor: newLabelColor }}
                    />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div className="grid grid-cols-4 gap-1.5">
                    {LABEL_COLORS.map((color) => (
                      <Button
                        key={color.value}
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setNewLabelColor(color.value)}
                        className="w-8 h-8 rounded-md flex items-center justify-center hover:scale-110 transition-transform"
                        style={{ backgroundColor: color.value }}
                        title={t.mail.sidebar[color.key]}
                      >
                        {newLabelColor === color.value && (
                          <Check className="h-4 w-4 text-white drop-shadow-sm" strokeWidth={3} />
                        )}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Input
                id="sidebar-label-name"
                placeholder={t.mail.sidebar.enterLabelName}
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreatingLabel) {
                    handleCreateLabel();
                  }
                }}
                autoFocus
              />
            </div>
          </div>

          {/* Agent Auto-Labeling Configuration */}
          <div className="pt-4 mt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label className="flex items-center gap-2">
                  <img src="/assets/images/weldagent/logo-light.png" alt="AI" width={18} height={18} />
                  {t.mail.sidebar.agentAutoLabeling}
                </Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[220px]">
                    {t.mail.sidebar.tooltipAutoLabel}
                  </TooltipContent>
                </Tooltip>
              </div>
              <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
            </div>

            <div className={`grid transition-all duration-300 ease-in-out ${aiEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="space-y-4 pt-4 pb-2">
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="sidebar-ai-keywords">{t.mail.sidebar.labelKeywords}</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                            <Info className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[220px]">
                          {t.mail.sidebar.tooltipKeywords}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <KeywordTagInput
                      value={aiKeywords}
                      onChange={setAiKeywords}
                      placeholder={t.mail.sidebar.typeAndPressComma}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="sidebar-ai-description">{t.mail.sidebar.labelAiDescription}</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                            <Info className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[220px]">
                          {t.mail.sidebar.tooltipAiDescription}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <Textarea
                      id="sidebar-ai-description"
                      placeholder={t.mail.sidebar.applyToEmailsAboutPlaceholder}
                      value={aiDescription}
                      onChange={(e) => setAiDescription(e.target.value)}
                      rows={3}
                      className="bg-background"
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Label>{t.mail.sidebar.labelMinConfidence}</Label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground h-auto w-auto p-0">
                              <Info className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px]">
                            {t.mail.sidebar.tooltipMinConfidence}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <span className="text-sm font-medium tabular-nums">{aiConfidence}%</span>
                    </div>
                    <Slider
                      value={[aiConfidence]}
                      onValueChange={(value) => setAiConfidence(value[0])}
                      min={0}
                      max={100}
                      step={5}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={resetLabelDialog} disabled={isCreatingLabel}>
            {t.mail.sidebar.cancel}
          </Button>
          <Button onClick={handleCreateLabel} disabled={isCreatingLabel}>
            {isCreatingLabel ? t.mail.sidebar.creating : t.mail.sidebar.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );

  return {
    menuGroups,
    dialogs,
    emailAccountProps: {
      currentEmailAccount: currentUserMenuAccount,
      emailAccounts: userMenuAccounts,
      onEmailAccountSwitch: handleAccountSwitch,
      onEmailAccountAdd: handleAccountAdd,
      defaultEmailAccountId,
      onSetDefaultEmailAccount: handleSetDefaultAccount,
      setDefaultLabel: t.mail.sidebar.setAsDefault,
      defaultLabel: t.mail.sidebar.defaultAccount,
    },
  };
}
