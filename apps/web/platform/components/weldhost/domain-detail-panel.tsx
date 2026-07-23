import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { CustomerChatPanel } from '@/components/customer-chat/customer-chat-panel';
import { EntityChat } from '@/components/entity-chat/entity-chat';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import {
  X,
  ExternalLink,
  Copy,
  Trash2,
  EllipsisVertical,
  Maximize,
  Minimize,
  PanelLeftOpen,
  PanelRightOpen,
  Globe,
  RefreshCcw,
  Lock,
  Shield,
  Mail,
  ShieldCheck,
  Calendar as CalendarIcon,
  Building2,
  Server,
  Tag,
  CircleDot,
  ListCollapse,
  Clock,
  AlertTriangle,
  User,
  Settings as SettingsIcon,
  History,
  KeyRound,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useRouter } from '@/lib/router';
import type { HostDomain, DomainContact } from '@/lib/api/domains/weldhost';

interface DomainDetailPanelProps {
  domain: HostDomain | null;
  isOpen: boolean;
  onClose: () => void;
  onDelete?: (domainId: string) => void;
  width?: string;
  /**
   * Optional controlled-mode props. When supplied, the panel uses these for
   * its expanded/collapsed state instead of internal `useState`. Lets the
   * EntitySheet drive expansion via the URL `?view=full` flag while leaving
   * existing direct callers (which don't pass these) on the prior local-state
   * behavior.
   */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const statusPill: Record<string, { labelKey: string; color: string }> = {
  active: { labelKey: 'sweep.shared.domainStatus.active', color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950' },
  pending: { labelKey: 'sweep.shared.domainStatus.pending', color: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950' },
  expired: { labelKey: 'sweep.shared.domainStatus.expired', color: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950' },
  suspended: { labelKey: 'sweep.shared.domainStatus.suspended', color: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950' },
  cancelled: { labelKey: 'sweep.shared.domainStatus.cancelled', color: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary' },
};

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
// Same wrapper used by TaskDetailContent for value cells.
const VALUE_WRAPPER = 'flex-1 h-8 text-sm rounded-md px-2 -mx-2 flex items-center';

function formatDate(value: string | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysUntil(value: string | undefined): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function FieldRow({
  icon: Icon,
  label,
  children,
  wideLabels = false,
}: {
  icon: typeof CircleDot;
  label: string;
  children: React.ReactNode;
  wideLabels?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn('flex items-center gap-2 flex-shrink-0', wideLabels ? 'w-48' : 'w-32')}>
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className={VALUE_WRAPPER}>{children}</div>
    </div>
  );
}

function YesNoPill({ enabled }: { enabled: boolean }) {
  const t = useTranslations();
  return enabled ? (
    <span className={cn(PILL, 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950')}>
      {t('sweep.shared.enabled')}
    </span>
  ) : (
    <span className={cn(PILL, 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>
      {t('sweep.shared.disabled')}
    </span>
  );
}

function ContactCard({ title, contact }: { title: string; contact: DomainContact | undefined }) {
  if (!contact?.email) return null;
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || '—';
  return (
    <div className="rounded-md border border-border/60 bg-background p-3 space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="text-sm font-medium text-foreground">{name}</div>
      {contact.organization && (
        <div className="text-xs text-muted-foreground">{contact.organization}</div>
      )}
      {contact.email && (
        <div className="text-xs text-muted-foreground break-all">{contact.email}</div>
      )}
      {contact.phone && <div className="text-xs text-muted-foreground">{contact.phone}</div>}
      {(contact.address1 || contact.city || contact.country) && (
        <div className="text-xs text-muted-foreground pt-1">
          {[contact.address1, contact.address2, contact.city, contact.state, contact.postalCode, contact.country]
            .filter(Boolean)
            .join(', ')}
        </div>
      )}
    </div>
  );
}

export function DomainDetailPanel({
  domain,
  isOpen,
  onClose,
  onDelete,
  width = '480px',
  isExpanded: isExpandedProp,
  onToggleExpand,
}: DomainDetailPanelProps) {
  const t = useTranslations();
  const router = useRouter();
  const widthNum = parseInt(width, 10) || 480;
  const [activeTab, setActiveTab] = useState('details');
  const [isExpandedLocal, setIsExpandedLocal] = useState(false);
  const {
    fields: drawerFields,
    fieldVisibility: drawerFieldVisibility,
    isFieldVisible,
    toggleField: drawerToggleField,
    resetToDefaults: drawerResetToDefaults,
  } = useDrawerFieldVisibility('domain-detail-panel');

  // Controlled when caller provides isExpanded; otherwise internal state.
  const isControlled = isExpandedProp !== undefined;
  const isExpanded = isControlled ? !!isExpandedProp : isExpandedLocal;
  const setIsExpanded = (next: boolean) => {
    if (isControlled) {
      // Caller owns the state — let them flip it via onToggleExpand.
      if (next !== isExpanded) onToggleExpand?.();
    } else {
      setIsExpandedLocal(next);
    }
  };

  // Reset to compact mode whenever the panel closes / re-opens for a new domain.
  // Only applies in uncontrolled mode — controlled callers manage this themselves.
  useEffect(() => {
    if (!isOpen && !isControlled) setIsExpandedLocal(false);
  }, [isOpen, isControlled]);

  // Notify host-layout-client to shrink the content area while open.
  // We deliberately report a constant `widthNum` (the collapsed width)
  // regardless of `isExpanded`. Toggling the reported width on expand would
  // yank the page layout sideways simultaneously with the panel's own width
  // animation — the user reads that as the page jumping in all directions.
  // Keeping the reservation constant keeps the page underneath stable; the
  // expanded panel simply overlays more of it on top.
  useLayoutEffect(() => {
    window.dispatchEvent(
      new CustomEvent('task-detail-panel', {
        detail: { isOpen, width: widthNum },
      }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent('task-detail-panel', { detail: { isOpen: false, width: 0 } }),
      );
    };
  }, [isOpen, widthNum]);

  // Step aside if WeldAgent or another global panel asks.
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  /*
   * Smooth right-to-left expand/collapse — copied verbatim from the team-
   * member detail panel so all detail panels share the exact same
   * maximize/minimize motion.
   *
   * Both directions swap `renderExpanded` immediately when `isExpanded`
   * flips. Maximize swaps to the wide layout so it has time to settle while
   * the width grows around it; minimize swaps to the compact layout up-front
   * so the *narrower* tabs row is what animates as the width shrinks
   * (otherwise the wider expanded tabs row visibly overflowed at the end of
   * the resize and snapped to the collapsed row).
   */
  const PANEL_TRANSITION_MS = 300;
  const PANEL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const [renderExpanded, setRenderExpanded] = useState(isExpanded);
  const [animatingWidth, setAnimatingWidth] = useState(false);
  const prevIsExpandedRef = useRef(isExpanded);

  // Detect the `isExpanded` prop change DURING render and flip the local
  // animation state in the same render. See customer-detail-view for the
  // full explanation — TL;DR: this is the only way to guarantee the new
  // `width` and `transition: width 300ms` ship in the same commit, which
  // is what makes the browser actually animate the resize instead of
  // snapping to the new size. Using useEffect or useLayoutEffect here was
  // painting the new width before the transition was set, missing the
  // animation entirely.
  if (prevIsExpandedRef.current !== isExpanded) {
    prevIsExpandedRef.current = isExpanded;
    setAnimatingWidth(true);
    setRenderExpanded(isExpanded);
  }

  useEffect(() => {
    if (!animatingWidth) return;
    const timer = setTimeout(() => setAnimatingWidth(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [animatingWidth]);

  // Right-side chat panel width (expanded mode). Always 500px on every load
  // and every panel open — not persisted. Drag-resizes apply only to the
  // current session and reset on reload / reopen.
  const DEFAULT_CHAT_WIDTH = 500;
  const MIN_CHAT_WIDTH = 320;
  const MAX_CHAT_WIDTH = 900;
  const [chatWidth, setChatWidth] = useState<number>(DEFAULT_CHAT_WIDTH);
  const widthDragRef = useRef(false);
  const handleChatWidthMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    widthDragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!widthDragRef.current) return;
      const next = Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, window.innerWidth - e.clientX));
      setChatWidth(next);
    };
    const onMouseUp = () => {
      if (!widthDragRef.current) return;
      widthDragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Chat open/close (expanded mode only) — same toggle UX as weldflow project.
  const CHAT_OPEN_KEY = 'domain-chat-panel-open';
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem(CHAT_OPEN_KEY);
    if (raw === null) return true;
    return raw === 'true';
  });
  useEffect(() => {
    window.localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? 'true' : 'false');
  }, [chatOpen]);
  const toggleChat = useCallback(() => {
    setChatOpen((wasOpen) => {
      // Reopening the chat resets the width to the default. We deliberately
      // do NOT remember the user's last drag-resized width across close/open
      // cycles — the user expects a fresh default every time the chat
      // reappears, even if they previously dragged it wider or narrower.
      if (!wasOpen) setChatWidth(DEFAULT_CHAT_WIDTH);
      return !wasOpen;
    });
  }, []);

  // Bottom-pinned chat height (compact mode) — drag the top edge to resize.
  const CHAT_HEIGHT_KEY = 'domain-panel-chat-height';
  const DEFAULT_CHAT_HEIGHT = 320;
  const MIN_CHAT_HEIGHT = 120;
  const [chatHeight, setChatHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_CHAT_HEIGHT;
    const raw = window.localStorage.getItem(CHAT_HEIGHT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_CHAT_HEIGHT ? parsed : DEFAULT_CHAT_HEIGHT;
  });
  useEffect(() => {
    window.localStorage.setItem(CHAT_HEIGHT_KEY, String(chatHeight));
  }, [chatHeight]);
  const heightDragRef = useRef(false);
  const heightStartYRef = useRef(0);
  const heightStartRef = useRef(0);
  const panelElRef = useRef<HTMLDivElement>(null);
  const handleChatHeightPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    heightDragRef.current = true;
    heightStartYRef.current = e.clientY;
    heightStartRef.current = chatHeight;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [chatHeight]);
  const handleChatHeightPointerMove = useCallback((e: React.PointerEvent) => {
    if (!heightDragRef.current) return;
    const delta = heightStartYRef.current - e.clientY;
    const panelHeight = panelElRef.current?.offsetHeight ?? 800;
    const maxHeight = panelHeight - 80;
    const next = Math.max(MIN_CHAT_HEIGHT, Math.min(heightStartRef.current + delta, maxHeight));
    setChatHeight(next);
  }, []);
  const handleChatHeightPointerUp = useCallback(() => {
    heightDragRef.current = false;
  }, []);

  if (!domain) return null;

  const status = statusPill[domain.status] ?? statusPill.active;
  const days = daysUntil(domain.expiresAt);
  const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;

  const allTabs: PageTab[] = [
    { id: 'details', label: t('sweep.shared.details'), icon: ListCollapse },
    { id: 'nameservers', label: t('sweep.shared.nameservers'), icon: Server },
    { id: 'settings', label: t('sweep.shared.settings'), icon: SettingsIcon },
    { id: 'history', label: t('sweep.shared.history'), icon: History },
  ];
  const visibleTabs = allTabs.filter((tab) => isFieldVisible(tab.id));
  // Compact panel keeps the tab strip airy — cap at 4 visible to leave room
  // for the configure / chat-toggle icons. Expanded mode renders the full set.
  const tabs: PageTab[] = renderExpanded ? visibleTabs : visibleTabs.slice(0, 4);

  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none"
          aria-label={t('sweep.shared.moreActions')}
        >
          <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => router.push(`/weldhost/domains/${domain.id}`)}>
          <ExternalLink className="h-4 w-4 mr-0.5" />
          {t('sweep.shared.openFullPage')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(fullDomain)}>
          <Copy className="h-4 w-4 mr-0.5" />
          {t('sweep.shared.copyDomain')}
        </DropdownMenuItem>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
              onClick={() => {
                onDelete(domain.id);
                onClose();
              }}
            >
              <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
              {t('sweep.shared.deleteDomain')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const tabContent = (
    <div className="p-4">
          {activeTab === 'details' && (
            <div className="space-y-1">
              <FieldRow icon={CircleDot} label={t('sweep.shared.status')} wideLabels={renderExpanded}>
                <span className={cn(PILL, status.color)}>{t(status.labelKey)}</span>
              </FieldRow>

              <FieldRow icon={Tag} label={t('sweep.shared.tld')} wideLabels={renderExpanded}>
                <span className={cn(PILL, 'font-mono text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>
                  .{domain.tld}
                </span>
              </FieldRow>

              <FieldRow icon={Building2} label={t('sweep.shared.registrar')} wideLabels={renderExpanded}>
                <span className="text-foreground">{domain.registrar || 'WeldHost'}</span>
              </FieldRow>

              <FieldRow icon={CalendarIcon} label={t('sweep.shared.registered')} wideLabels={renderExpanded}>
                <span className="text-muted-foreground">{formatDate(domain.registeredAt) || t('sweep.shared.notSet')}</span>
              </FieldRow>

              <FieldRow icon={CalendarIcon} label={t('sweep.shared.expires')} wideLabels={renderExpanded}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground">{formatDate(domain.expiresAt) || t('sweep.shared.notSet')}</span>
                  {days !== null && days < 0 && (
                    <span className={cn(PILL, 'gap-1 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950')}>
                      <AlertTriangle className="h-3 w-3" />
                      {t('sweep.shared.domainStatus.expired')}
                    </span>
                  )}
                  {days !== null && days >= 0 && days < 30 && (
                    <span className={cn(PILL, 'gap-1 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950')}>
                      <Clock className="h-3 w-3" />
                      {t('sweep.shared.daysLeft', { count: days })}
                    </span>
                  )}
                </div>
              </FieldRow>

              {domain.renewedAt && (
                <FieldRow icon={CalendarIcon} label={t('sweep.shared.renewed')} wideLabels={renderExpanded}>
                  <span className="text-muted-foreground">{formatDate(domain.renewedAt)}</span>
                </FieldRow>
              )}

              <FieldRow icon={Clock} label={t('sweep.shared.created')} wideLabels={renderExpanded}>
                <span className="text-muted-foreground">{formatDate(domain.createdAt)}</span>
              </FieldRow>

              <FieldRow icon={Clock} label={t('sweep.shared.lastUpdated')} wideLabels={renderExpanded}>
                <span className="text-muted-foreground">{formatDate(domain.updatedAt)}</span>
              </FieldRow>

              <FieldRow icon={CircleDot} label={t('sweep.shared.domainId')} wideLabels={renderExpanded}>
                <span className="font-mono text-xs text-muted-foreground break-all">{domain.id}</span>
              </FieldRow>
            </div>
          )}

          {activeTab === 'nameservers' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    PILL,
                    domain.nameserverVerified
                      ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950'
                      : domain.nameserverVerificationPending
                        ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950'
                        : 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
                  )}
                >
                  {domain.nameserverVerified
                    ? t('sweep.shared.verified')
                    : domain.nameserverVerificationPending
                      ? t('sweep.shared.pendingVerification')
                      : t('sweep.shared.notVerified')}
                </span>
                {domain.customNameservers && (
                  <span className={cn(PILL, 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950')}>
                    {t('sweep.shared.custom')}
                  </span>
                )}
              </div>

              {domain.nameservers && domain.nameservers.length > 0 ? (
                <div className="space-y-1">
                  {domain.nameservers.map((ns) => (
                    <div
                      key={ns}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-muted/50 border border-border/60"
                    >
                      <span className="text-sm font-mono text-foreground truncate">{ns}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void navigator.clipboard.writeText(ns)}
                        className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex-shrink-0"
                        title={t('sweep.shared.copy')}
                        aria-label={t('sweep.shared.copyValue', { value: ns })}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('sweep.shared.noNameserversConfigured')}</p>
              )}

              {domain.nameserverVerificationToken && (
                <FieldRow icon={KeyRound} label={t('sweep.shared.token')} wideLabels={renderExpanded}>
                  <span className="font-mono text-xs text-muted-foreground break-all">
                    {domain.nameserverVerificationToken}
                  </span>
                </FieldRow>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-1">
              <FieldRow icon={RefreshCcw} label={t('sweep.shared.autoRenew')} wideLabels={renderExpanded}>
                <YesNoPill enabled={domain.autoRenew} />
              </FieldRow>
              <FieldRow icon={ShieldCheck} label={t('sweep.shared.ssl')} wideLabels={renderExpanded}>
                <YesNoPill enabled={domain.sslEnabled} />
              </FieldRow>
              <FieldRow icon={Mail} label={t('sweep.shared.emailForwarding')} wideLabels={renderExpanded}>
                <YesNoPill enabled={domain.emailForwardingEnabled} />
              </FieldRow>
              <FieldRow icon={Shield} label={t('sweep.shared.privacyProtection')} wideLabels={renderExpanded}>
                <YesNoPill enabled={domain.privacyProtection} />
              </FieldRow>
              <FieldRow icon={Lock} label={t('sweep.shared.transferLock')} wideLabels={renderExpanded}>
                <YesNoPill enabled={domain.locked} />
              </FieldRow>
              {domain.authCode && (
                <FieldRow icon={KeyRound} label={t('sweep.shared.authCode')} wideLabels={renderExpanded}>
                  <span className="font-mono text-xs text-muted-foreground break-all">{domain.authCode}</span>
                </FieldRow>
              )}
              {domain.notes && (
                <div className="pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    {t('sweep.shared.notes')}
                  </div>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{domain.notes}</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-1">
              <FieldRow icon={Clock} label={t('sweep.shared.created')} wideLabels={renderExpanded}>
                <span className="text-muted-foreground">{formatDate(domain.createdAt)}</span>
              </FieldRow>
              {domain.registeredAt && (
                <FieldRow icon={CalendarIcon} label={t('sweep.shared.registered')} wideLabels={renderExpanded}>
                  <span className="text-muted-foreground">{formatDate(domain.registeredAt)}</span>
                </FieldRow>
              )}
              {domain.renewedAt && (
                <FieldRow icon={CalendarIcon} label={t('sweep.shared.renewed')} wideLabels={renderExpanded}>
                  <span className="text-muted-foreground">{formatDate(domain.renewedAt)}</span>
                </FieldRow>
              )}
              {domain.expiresAt && (
                <FieldRow icon={CalendarIcon} label={t('sweep.shared.expires')} wideLabels={renderExpanded}>
                  <span className="text-muted-foreground">{formatDate(domain.expiresAt)}</span>
                </FieldRow>
              )}
              <FieldRow icon={Clock} label={t('sweep.shared.lastUpdated')} wideLabels={renderExpanded}>
                <span className="text-muted-foreground">{formatDate(domain.updatedAt)}</span>
              </FieldRow>
              {domain.registrarSyncedAt && (
                <FieldRow icon={Clock} label={t('sweep.shared.registrarSync')} wideLabels={renderExpanded}>
                  <span className="text-muted-foreground">{formatDate(domain.registrarSyncedAt)}</span>
                </FieldRow>
              )}
              <p className="text-xs text-muted-foreground pt-3">
                {t('sweep.shared.auditLogWillAppearHere')}
              </p>
            </div>
          )}
    </div>
  );

  return (
    <div
      ref={panelElRef}
      className={cn(
        'fixed bg-background z-50 flex flex-col overflow-x-hidden',
        !isExpanded && 'border-l border-border',
        'inset-0',
        'md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
        'transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
        isOpen ? 'translate-x-0' : 'translate-x-full',
        !isOpen && 'pointer-events-none',
        // While the width is animating, clip any content that would otherwise
        // bleed past the shrinking/growing panel edge. Lifted again at rest so
        // popovers and tooltips that anchor to the panel edge don't get
        // clipped in steady state.
        animatingWidth && 'overflow-hidden',
      )}
      style={{
        width: isExpanded ? 'calc(100% - 64px - 16rem)' : width,
        transition: animatingWidth
          ? `width ${PANEL_TRANSITION_MS}ms ${PANEL_EASING}, transform 500ms ${PANEL_EASING}`
          : undefined,
        willChange: animatingWidth ? 'width' : undefined,
      }}
    >
      {/* Compact panel header — same chrome in both compact and expanded modes */}
      <div className="group/header relative px-3 md:px-4 py-3 min-h-[51px] flex-shrink-0">
        <div className="absolute top-3 right-3 md:right-4 flex items-center gap-0.5 md:gap-1">
          {moreMenu}
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? t('sweep.shared.minimize') : t('sweep.shared.expand')}
            aria-label={isExpanded ? t('sweep.shared.minimizePanel') : t('sweep.shared.expandPanel')}
          >
            {isExpanded ? (
              <Minimize className="h-4 w-4 text-gray-500" />
            ) : (
              <Maximize className="h-4 w-4 text-gray-500" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={onClose}
            title={t('sweep.shared.close')}
            aria-label={t('sweep.shared.closePanel')}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>

        {/* Title row */}
        <div className="flex items-start gap-2 pr-28 min-w-0">
          <Globe className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-[2px]" />
          <div className="translate-y-[0.5px] text-[15px] font-medium leading-normal text-foreground break-words min-w-0">
            {fullDomain}
          </div>
        </div>
      </div>

      <div className="relative">
        <PageTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className="border-border"
          innerClassName="px-4"
        />
        <div className="absolute top-0 right-0 h-full flex items-center gap-0.5 pr-2 md:pr-3 -translate-y-[4px]">
          <DrawerFieldSettings
            fields={drawerFields}
            fieldVisibility={drawerFieldVisibility}
            onToggle={drawerToggleField}
            onReset={drawerResetToDefaults}
            label={t('sweep.shared.visibleTabs')}
          />
          {renderExpanded && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleChat}
              aria-label={chatOpen ? t('sweep.shared.closeChat') : t('sweep.shared.openChat')}
              title={chatOpen ? t('sweep.shared.closeChat') : t('sweep.shared.openChat')}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {chatOpen ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      {renderExpanded ? (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Content (left) */}
          <div className="flex-1 overflow-hidden min-w-0 flex flex-col">
            <div className="flex-1 overflow-y-auto overflow-x-hidden">{tabContent}</div>
          </div>
          {/* Chat panel (right) — same design as the customer / weldflow chat. */}
          {chatOpen && (
          <div
            className="relative flex-shrink-0 bg-background border-l border-border flex flex-col"
            style={{ width: chatWidth }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
              onMouseDown={handleChatWidthMouseDown}
            >
              <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                <div className="h-6 w-1 rounded-full bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-accent transition-colors" />
              </div>
            </div>
            <div className="flex-1 min-w-0 h-full">
              <CustomerChatPanel
                customerId={domain.id}
                customerName={fullDomain}
                entityType="domain"
              />
            </div>
          </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto overflow-x-hidden">{tabContent}</div>
          {/* Bottom-pinned chat — resizable, no header (matches customer compact panel). */}
          <div className="flex-shrink-0 flex flex-col" style={{ height: chatHeight }}>
            <div
              onPointerDown={handleChatHeightPointerDown}
              onPointerMove={handleChatHeightPointerMove}
              onPointerUp={handleChatHeightPointerUp}
              className="h-[9px] flex-shrink-0 cursor-row-resize flex items-center justify-center group touch-none"
            >
              <div className="w-8 h-[3px] rounded-full bg-gray-300 dark:bg-border opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 chat-flush">
              <EntityChat
                entityType="domain"
                entityId={domain.id}
                fallbackName={fullDomain}
                hideHeader
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DomainRecordDetails({ domain }: { domain: HostDomain }) {
  const t = useTranslations();
  const [open, setOpen] = useState(true);
  const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;
  const status = statusPill[domain.status] ?? statusPill.active;
  const days = daysUntil(domain.expiresAt);

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left text-sm font-medium text-foreground hover:text-foreground/80 transition-colors"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
        {t('sweep.shared.recordDetails')}
      </Button>
      {open && (
        <div className="mt-2 space-y-1">
          <SidebarRow icon={Globe} label={t('sweep.shared.domain')}>
            <span className="font-mono text-sm">{fullDomain}</span>
          </SidebarRow>
          <SidebarRow icon={CircleDot} label={t('sweep.shared.status')}>
            <span className={cn(PILL, status.color)}>{t(status.labelKey)}</span>
          </SidebarRow>
          <SidebarRow icon={Tag} label={t('sweep.shared.tld')}>
            <span className={cn(PILL, 'font-mono text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>
              .{domain.tld}
            </span>
          </SidebarRow>
          <SidebarRow icon={Building2} label={t('sweep.shared.registrar')}>
            <span className="text-sm">{domain.registrar || 'WeldHost'}</span>
          </SidebarRow>
          <SidebarRow icon={CalendarIcon} label={t('sweep.shared.registered')}>
            <span className="text-sm text-muted-foreground">{formatDate(domain.registeredAt) || '—'}</span>
          </SidebarRow>
          <SidebarRow icon={CalendarIcon} label={t('sweep.shared.expires')}>
            <span className="text-sm text-muted-foreground">{formatDate(domain.expiresAt) || '—'}</span>
          </SidebarRow>
          {days !== null && (
            <SidebarRow icon={Clock} label={t('sweep.shared.remaining')}>
              <span
                className={cn(
                  PILL,
                  days < 0
                    ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950'
                    : days < 30
                      ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950'
                      : 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
                )}
              >
                {days < 0 ? t('sweep.shared.expiredDaysAgo', { count: -days }) : t('sweep.shared.daysShort', { count: days })}
              </span>
            </SidebarRow>
          )}
          <SidebarRow icon={RefreshCcw} label={t('sweep.shared.autoRenew')}>
            <YesNoPill enabled={domain.autoRenew} />
          </SidebarRow>
          <SidebarRow icon={ShieldCheck} label={t('sweep.shared.ssl')}>
            <YesNoPill enabled={domain.sslEnabled} />
          </SidebarRow>
          <SidebarRow icon={Mail} label={t('sweep.shared.emailForwarding')}>
            <YesNoPill enabled={domain.emailForwardingEnabled} />
          </SidebarRow>
          <SidebarRow icon={Shield} label={t('sweep.shared.privacy')}>
            <YesNoPill enabled={domain.privacyProtection} />
          </SidebarRow>
          <SidebarRow icon={Lock} label={t('sweep.shared.transferLock')}>
            <YesNoPill enabled={domain.locked} />
          </SidebarRow>
          {domain.registrantContact?.email && (
            <SidebarRow icon={User} label={t('sweep.shared.registrant')}>
              <span className="text-sm truncate">{domain.registrantContact.email}</span>
            </SidebarRow>
          )}
          {domain.adminContact?.email && (
            <SidebarRow icon={User} label={t('sweep.shared.admin')}>
              <span className="text-sm truncate">{domain.adminContact.email}</span>
            </SidebarRow>
          )}
          {domain.techContact?.email && (
            <SidebarRow icon={User} label={t('sweep.shared.technical')}>
              <span className="text-sm truncate">{domain.techContact.email}</span>
            </SidebarRow>
          )}
          {domain.billingContact?.email && (
            <SidebarRow icon={User} label={t('sweep.shared.billing')}>
              <span className="text-sm truncate">{domain.billingContact.email}</span>
            </SidebarRow>
          )}
          <SidebarRow icon={Clock} label={t('sweep.shared.created')}>
            <span className="text-sm text-muted-foreground">{formatDate(domain.createdAt)}</span>
          </SidebarRow>
          <SidebarRow icon={Clock} label={t('sweep.shared.lastUpdated')}>
            <span className="text-sm text-muted-foreground">{formatDate(domain.updatedAt)}</span>
          </SidebarRow>
        </div>
      )}
    </div>
  );
}

function SidebarRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof CircleDot;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 min-h-[28px]">
      <div className="flex items-center gap-2 w-32 flex-shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-foreground">{children}</div>
    </div>
  );
}
