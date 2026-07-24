
import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { PanelLeftOpen, PanelRightOpen, ChevronLeft, ChevronUp } from 'lucide-react';
import { CustomerDetailProvider } from './customer-detail-provider';
import { useCustomerDetailContext } from './customer-detail-provider';
import { CustomerDetailHeader } from './customer-detail-header';
import { CustomerDetailTabs } from './customer-detail-tabs';
import { CustomerDetailContent } from './customer-detail-content';
import { CustomerChatPanel } from '@/components/customer-chat/customer-chat-panel';
import { EntityChat } from '@/components/entity-chat/entity-chat';
import { useQuery } from '@tanstack/react-query';
import { weldchatEntityApi } from '@/lib/api/domains/weldchat-entity';
import type { CustomerDetailViewProps } from './types';
import { NoteEditorDialog } from './note-editor-dialog';
import { useUpdateCustomerNote, useDeleteCustomerNote } from '@/hooks/queries/use-customer-notes-queries';
import { toast } from 'sonner';
import { TaskDialog } from '@/app/weldcrm/task-dialog';
import { useCreateTask, useUpdateTask } from '@/hooks/use-crm-tasks';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * CustomerDetailView - Shared component for displaying customer details
 *
 * Supports three display modes:
 * - page: Full page layout with sidebar (CRM customer detail page)
 * - panel: Sliding panel from right (Mail app, order views)
 * - embedded: Compact view without header/sidebar (embedded in other pages)
 */
export function CustomerDetailView({
  customerId,
  entityType = 'customer',
  mode = 'page',
  isOpen = true,
  onClose,
  width = '500px',
  topOffset = '117px',
  isExpanded,
  onToggleExpand,
  initialData,
  showHeader = true,
  showTabs = true,
  showSidebar = true,
  defaultTab = 'overview',
  onNavigateToCustomer,
  onCompose,
  onCall,
  onDelete,
  listId,
  returnUrl,
  navigation,
  visitorLocation,
  onBack,
}: CustomerDetailViewProps) {
  // Panel mode
  if (mode === 'panel') {
    // When stacked on a parent panel (`onBack` set), the X button inside the
    // header should close BOTH panels via `close-detail-panels` instead of
    // just closing this one. The layout's own listener reads from the prop
    // (the real `onClose`) — no infinite loop.
    const headerOnClose = onBack
      ? () => window.dispatchEvent(new CustomEvent('close-detail-panels'))
      : onClose;
    return (
      <CustomerDetailProvider
        customerId={customerId}
        entityType={entityType}
        mode={mode}
        initialData={initialData}
        navigation={navigation}
        defaultTab={defaultTab}
        showHeader={showHeader}
        showTabs={showTabs}
        showSidebar={false}
        listId={listId}
        returnUrl={returnUrl}
        onCompose={onCompose}
        onCall={onCall}
        onClose={headerOnClose}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      >
        <CustomerDetailPanelLayout
          isOpen={isOpen}
          onClose={onClose}
          onDelete={onDelete}
          width={width}
          topOffset={topOffset}
          isExpanded={isExpanded}
          onBack={onBack}
        />
      </CustomerDetailProvider>
    );
  }

  // Embedded mode
  if (mode === 'embedded') {
    return (
      <CustomerDetailProvider
        customerId={customerId}
        entityType={entityType}
        mode={mode}
        initialData={initialData}
        navigation={navigation}
        defaultTab={defaultTab}
        showHeader={showHeader}
        showTabs={showTabs}
        showSidebar={false}
        listId={listId}
        returnUrl={returnUrl}
        onCompose={onCompose}
        onCall={onCall}
        onClose={onClose}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        visitorLocation={visitorLocation}
      >
        <CustomerDetailEmbeddedLayout />
      </CustomerDetailProvider>
    );
  }

  // Page mode (default)
  return (
    <CustomerDetailProvider
      customerId={customerId}
      entityType={entityType}
      mode={mode}
      initialData={initialData}
      navigation={navigation}
      defaultTab={defaultTab}
      showHeader={showHeader}
      showTabs={showTabs}
      showSidebar={showSidebar}
      listId={listId}
      returnUrl={returnUrl}
      onCompose={onCompose}
      onCall={onCall}
      onClose={onClose}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
    >
      <CustomerDetailPageLayout
        onDelete={onDelete}
        onNavigateToCustomer={onNavigateToCustomer}
      />
    </CustomerDetailProvider>
  );
}

/**
 * Page layout - Full page with header, tabs, content, and sidebar
 */
const DEFAULT_CUSTOMER_CHAT_WIDTH = 500;
const MIN_CUSTOMER_CHAT_WIDTH = 320;
const MAX_CUSTOMER_CHAT_WIDTH = 900;

function CustomerDetailPageLayout({
  onDelete,
  onNavigateToCustomer,
}: {
  onDelete?: () => void;
  onNavigateToCustomer?: (customerId: string) => void;
}) {
  const t = useTranslations();
  const { data, customerId, entityType, isLoading } = useCustomerDetailContext();

  const customer = data?.customer;
  const isB2B = (customer?.type ?? '').toLowerCase() === 'b2b';
  const customerName = customer
    ? isB2B
      ? customer.companyName || customer.tradingName || t('sweep.weldcrm.customerDetailContent.customer')
      : customer.fullName ||
        `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() ||
        customer.companyName ||
        t('sweep.weldcrm.customerDetailContent.customer')
    : undefined;
  const showChat = (entityType === 'customer' || entityType === 'contact') && !!customer;

  // Chat panel width is always the standard 500px on every load and every
  // panel open. We deliberately do NOT persist the user's drag-resized width
  // — it always resets to the default. The state is kept (rather than
  // hardcoding the constant) so the drag handlers can still tweak the width
  // during the current session.
  const [chatWidth, setChatWidth] = React.useState<number>(DEFAULT_CUSTOMER_CHAT_WIDTH);

  // Chat open/close — same toggle UX as the weldflow project page.
  const CHAT_OPEN_KEY = 'customer-chat-panel-open';
  const [chatOpen, setChatOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem(CHAT_OPEN_KEY);
    if (raw === null) return true;
    return raw === 'true';
  });
  React.useEffect(() => {
    window.localStorage.setItem(CHAT_OPEN_KEY, chatOpen ? 'true' : 'false');
  }, [chatOpen]);
  const toggleChat = React.useCallback(() => {
    setChatOpen((wasOpen) => {
      // Reopening the chat resets the width to the default. We deliberately
      // do NOT remember the user's last drag-resized width across close/open
      // cycles — the user expects a fresh 500px every time the chat
      // reappears, even if they previously dragged it wider or narrower.
      if (!wasOpen) setChatWidth(DEFAULT_CUSTOMER_CHAT_WIDTH);
      return !wasOpen;
    });
  }, []);

  const dragRef = React.useRef(false);
  const handleResizeMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(
        MIN_CUSTOMER_CHAT_WIDTH,
        Math.min(MAX_CUSTOMER_CHAT_WIDTH, window.innerWidth - e.clientX),
      );
      setChatWidth(next);
    };
    const onMouseUp = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
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

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Header */}
        <CustomerDetailHeader
          onDelete={onDelete}
          onNavigateToCustomer={onNavigateToCustomer}
        />

        {/* Tabs (full width, above content + chat) */}
        <div className="relative z-10">
          <CustomerDetailTabs />
          {showChat && (
            <div className="absolute top-0 right-0 h-full flex items-center pr-2 md:pr-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleChat}
                aria-label={chatOpen ? t('sweep.weldcrm.customerDetailView.closeCustomerChat') : t('sweep.weldcrm.customerDetailView.openCustomerChat')}
                title={chatOpen ? t('sweep.weldcrm.customerDetailView.closeCustomerChat') : t('sweep.weldcrm.customerDetailView.openCustomerChat')}
                className="h-7 w-7 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              >
                {chatOpen ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left Section - Content */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <div className={cn(
              "flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll transition-opacity duration-200",
              isLoading ? "opacity-0" : "opacity-100"
            )}>
              <CustomerDetailContent />
            </div>
          </div>

          {/* Right Sidebar — chat panel mirroring the weldflow project chat.
              `chat-flush-top` zeros the standard 16px top padding on the
              MessageInput wrapper inside, so the composer sits flush with the
              message list above. Horizontal and bottom padding stay intact. */}
          {showChat && chatOpen && (
            <div
              className="relative flex-shrink-0 bg-background border-l border-border flex flex-col chat-flush-top"
              style={{ width: chatWidth }}
            >
              {/* Resize handle on the left edge — drag to resize */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
                onMouseDown={handleResizeMouseDown}
              >
                <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                  <div className="h-6 w-1 rounded-full bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-accent transition-colors" />
                </div>
              </div>
              <div className="flex-1 min-w-0 h-full">
                <CustomerChatPanel
                  customerId={customerId}
                  customerName={customerName}
                  ownerId={customer?.ownerId ?? null}
                  accountManagerId={customer?.accountManagerId ?? null}
                  entityType={entityType === 'contact' ? 'contact' : 'customer'}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      <FloatingNoteEditor />
      <FloatingTaskDialog />
    </>
  );
}

/**
 * Panel layout - Sliding panel from right side
 */
function CustomerDetailPanelLayout({
  isOpen,
  onClose,
  onDelete,
  width,
  isExpanded,
  onBack,
}: {
  isOpen: boolean;
  onClose?: () => void;
  onDelete?: () => void;
  width: string;
  topOffset: string;
  isExpanded?: boolean;
  onBack?: () => void;
}) {
  const t = useTranslations();
  const { isLoading, data, customerId, entityType } = useCustomerDetailContext();

  // Parse width to number for events
  const widthNum = parseInt(width, 10) || 500;

  // Bottom-pinned, resizable chat — mirrors the task detail panel pattern
  // in apps/web/platform/components/task-detail/task-detail-panel.tsx.
  const CHAT_HEIGHT_KEY = 'customer-panel-chat-height';
  const DEFAULT_CHAT_HEIGHT = 320;
  const MIN_CHAT_HEIGHT = 120;
  const [chatHeight, setChatHeight] = React.useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_CHAT_HEIGHT;
    const raw = window.localStorage.getItem(CHAT_HEIGHT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_CHAT_HEIGHT ? parsed : DEFAULT_CHAT_HEIGHT;
  });
  // Whether the chat is collapsed (only the drag line stays visible at the
  // bottom). Toggled by double-clicking the drag line. Persisted across
  // mounts so the user's choice sticks.
  const CHAT_COLLAPSED_KEY = 'customer-panel-chat-collapsed';
  const [chatCollapsed, setChatCollapsed] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(CHAT_COLLAPSED_KEY) === '1';
  });
  React.useEffect(() => {
    window.localStorage.setItem(CHAT_COLLAPSED_KEY, chatCollapsed ? '1' : '0');
  }, [chatCollapsed]);
  React.useEffect(() => {
    window.localStorage.setItem(CHAT_HEIGHT_KEY, String(chatHeight));
  }, [chatHeight]);

  const isDraggingRef = React.useRef(false);
  const startYRef = React.useRef(0);
  const startHeightRef = React.useRef(0);
  const panelElRef = React.useRef<HTMLDivElement>(null);
  const tabsRowRef = React.useRef<HTMLDivElement>(null);
  const [maxChatHeight, setMaxChatHeight] = React.useState<number>(Infinity);

  // Track the live max chat height (panel height − tabs-bottom offset) so we
  // can hide the drag line until the user has expanded the chat past 70%.
  React.useLayoutEffect(() => {
    const update = () => {
      const panelEl = panelElRef.current;
      const tabsEl = tabsRowRef.current;
      if (!panelEl || !tabsEl) return;
      const panelTop = panelEl.getBoundingClientRect().top;
      const tabsBottom = tabsEl.getBoundingClientRect().bottom;
      const next = Math.max(MIN_CHAT_HEIGHT, panelEl.offsetHeight - (tabsBottom - panelTop));
      setMaxChatHeight(next);
    };
    update();
    const ro = new ResizeObserver(update);
    if (panelElRef.current) ro.observe(panelElRef.current);
    if (tabsRowRef.current) ro.observe(tabsRowRef.current);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const showResizeLine = chatHeight >= maxChatHeight * 0.7;

  const handleResizePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = chatHeight;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [chatHeight],
  );
  const handleResizePointerMove = React.useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const delta = startYRef.current - e.clientY;
    const panelEl = panelElRef.current;
    const panelHeight = panelEl?.offsetHeight ?? 800;
    // Cap the chat so its top edge can never go above the bottom of the tabs
    // row — the message section must always sit below the tabs.
    let maxHeight = panelHeight - 80;
    const tabsEl = tabsRowRef.current;
    if (tabsEl && panelEl) {
      const panelTop = panelEl.getBoundingClientRect().top;
      const tabsBottom = tabsEl.getBoundingClientRect().bottom;
      maxHeight = Math.max(MIN_CHAT_HEIGHT, panelHeight - (tabsBottom - panelTop));
    }
    const newHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(startHeightRef.current + delta, maxHeight));
    setChatHeight(newHeight);
  }, []);
  const handleResizePointerUp = React.useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const customer = data?.customer;
  const isB2B = (customer?.type ?? '').toLowerCase() === 'b2b';
  const customerName = customer
    ? isB2B
      ? customer.companyName || customer.tradingName || t('sweep.weldcrm.customerDetailContent.customer')
      : customer.fullName ||
        `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() ||
        customer.companyName ||
        t('sweep.weldcrm.customerDetailContent.customer')
    : undefined;
  // Both customers and contacts have entity-channel providers on the backend.
  const showChat = (entityType === 'customer' || entityType === 'contact') && !!customer;

  // Whether a chat channel exists for this entity. The channel is created on
  // the first sent message, so "channel exists" === "there is at least one
  // message". Used to hide the resize handle line + grip until the user has
  // actually started a conversation. Matches the same query that EntityChat
  // runs internally, so this reads from cache and adds no extra request.
  const channelEntityType = entityType === 'contact' ? 'contact' : 'customer';
  const channelQuery = useQuery({
    queryKey: ['entity-channel', channelEntityType, customerId],
    queryFn: () => weldchatEntityApi.getEntityChannel(channelEntityType, customerId),
    enabled: showChat && !!customerId,
    retry: false,
  });
  const hasMessages = !!channelQuery.data;

  // Close WeldAgent when this panel opens
  React.useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('close-weldagent'));
    }
  }, [isOpen]);

  // Notify layout of panel open/close so content width adjusts.
  // Always reports the collapsed width regardless of `isExpanded` so the page
  // layout reservation stays constant. Otherwise toggling expand yanks the
  // page content sideways while the panel itself is animating, which reads
  // as the page jumping in all directions. The expanded panel just overlays
  // more of the page; the underlying layout doesn't shift.
  // When `onBack` is set this panel is stacked on a parent panel — instead of
  // the page-layout event, dispatch `stacked-detail-panel` so the parent panel
  // can shrink its expanded width to fit this stacked panel beside it.
  React.useEffect(() => {
    const eventName = onBack ? 'stacked-detail-panel' : 'object-panel-reservation';
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: { isOpen, width: widthNum },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: { isOpen: false, width: 0 },
      }));
    };
  }, [isOpen, widthNum, onBack]);

  // Close this panel when WeldAgent opens
  React.useEffect(() => {
    if (!onClose) return;
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  // Only animate on first mount
  const hasAnimatedRef = React.useRef(false);
  const shouldAnimate = !hasAnimatedRef.current;
  if (isOpen) hasAnimatedRef.current = true;

  /*
   * Smooth panel expand/collapse — copied verbatim from the team-member
   * detail panel so both panels share the exact same maximize/minimize
   * motion.
   *
   * Two pieces of state are involved:
   *   • `isExpanded` (the user's intent — flips immediately on click)
   *   • `renderExpanded` (which inner layout we render — page vs. compact)
   *   • `animatingWidth` (gates the CSS width transition for ONE animation)
   *
   * Both directions swap `renderExpanded` immediately when `isExpanded`
   * flips: maximize swaps to the wide layout so it has time to settle while
   * the width grows around it, and minimize swaps to the compact layout
   * up-front so the *narrower* tabs row is what animates as the width
   * shrinks (otherwise the wider expanded tabs row visibly overflowed at
   * the end of the resize and snapped to the collapsed row).
   */
  const PANEL_TRANSITION_MS = 300;
  const PANEL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const [renderExpanded, setRenderExpanded] = React.useState(isExpanded);
  const [animatingWidth, setAnimatingWidth] = React.useState(false);
  const prevIsExpandedRef = React.useRef(isExpanded);

  // Detect the `isExpanded` prop change DURING render and flip the local
  // animation state in the same render pass. This is React's documented
  // pattern for "adjust state when a prop changes" without using an effect:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  //
  // Why it matters here: the team-member panel batches `setAnimatingWidth`
  // / `setRenderExpanded` / `setIsExpanded` inside a single click handler so
  // they all commit together — the browser sees the width change AND the
  // active CSS transition in the same paint, which is the condition that
  // triggers the resize animation. Customer/contact panels receive
  // `isExpanded` as a prop from a parent, so the click happens elsewhere.
  // Using `useEffect` (or even `useLayoutEffect`) here was painting the new
  // width with `transition: undefined` first and then adding the transition
  // a render later, so the resize SNAPPED instead of animating. Doing the
  // flip during render guarantees `width` and `transition` ship in the same
  // commit, exactly mirroring the team-member panel's batching.
  if (prevIsExpandedRef.current !== isExpanded) {
    prevIsExpandedRef.current = isExpanded;
    setAnimatingWidth(true);
    setRenderExpanded(isExpanded);
  }

  // Timer to flip `animatingWidth` back to false after the transition
  // finishes. Lives in its own effect because timers can't be scheduled
  // during render.
  React.useEffect(() => {
    if (!animatingWidth) return;
    const timer = setTimeout(() => setAnimatingWidth(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [animatingWidth]);

  // When this is the root (non-stacked) panel and a child panel stacks on top
  // (Task / Contact opened from a tab), shrink the expanded width so the
  // stacked panel fits next to it instead of overlapping. Only triggers the
  // width animation when expanded — in the collapsed state the stacked panel
  // covers the customer panel as a back-stack (existing UX), so no animation.
  const [stackedPanelWidth, setStackedPanelWidth] = React.useState(0);
  React.useEffect(() => {
    if (onBack) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { isOpen: boolean; width: number };
      const next = detail.isOpen ? detail.width : 0;
      setStackedPanelWidth(next);
      if (isExpanded) setAnimatingWidth(true);
    };
    window.addEventListener('stacked-detail-panel', handler);
    return () => window.removeEventListener('stacked-detail-panel', handler);
  }, [onBack, isExpanded]);

  if (!isOpen) return null;

  return (
    <>
      {/* Panel */}
      <div
        ref={panelElRef}
        className={cn(
          'fixed bg-background z-50 flex flex-col',
          !isExpanded && 'border-l border-border',
          'inset-0',
          'md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
          // While the width is animating, clip any content that would otherwise
          // bleed past the shrinking/growing panel edge. Lifted again at rest so
          // popovers, dropdowns and tooltips that anchor to the panel edge don't
          // get clipped in steady state.
          animatingWidth && 'overflow-hidden',
          // Mount-time entrance only. Toggling this class on while the element
          // stays mounted causes the CSS animation to *replay* (slide in from
          // translateX(100%) and fade from 50% opacity), which on a
          // maximize/minimize click reads as the panel disappearing and then
          // reappearing. `shouldAnimate` flips false after first open so the
          // class is never re-added.
          shouldAnimate && 'animate-in slide-in-from-right fade-in-50 duration-300',
        )}
        style={{
          width: isExpanded
            ? `calc(100% - 64px - 16rem${stackedPanelWidth > 0 ? ` - ${stackedPanelWidth}px` : ''})`
            : width,
          transition: animatingWidth ? `width ${PANEL_TRANSITION_MS}ms ${PANEL_EASING}` : undefined,
          willChange: animatingWidth ? 'width' : undefined,
        }}
      >
        {renderExpanded ? (
          <CustomerDetailPageLayout onDelete={onDelete} />
        ) : (
          <>
            {/* Back chevron — only when stacked on a parent panel. Sits
                above the header so the user can return to the parent panel. */}
            {onBack && (
              <div className="px-4 pt-3 -mb-1">
                <Button
                  variant="ghost"
                  className="group/back inline-flex items-center gap-1 -ml-1 px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground transition-colors h-auto"
                  onClick={onBack}
                  title={t('sweep.weldcrm.customerDetailView.back')}
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span className="group-hover/back:underline">{t('sweep.weldcrm.customerDetailView.back')}</span>
                </Button>
              </div>
            )}
            {/* Header */}
            <CustomerDetailHeader variant="panel" onDelete={onDelete} />

            {/* Tabs + Content area */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* Tabs Row */}
              <div ref={tabsRowRef} className="relative z-10">
                <CustomerDetailTabs variant="panel" />
              </div>

              {/* Content */}
              <div className={cn(
                "flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll transition-opacity duration-200",
                isLoading ? "opacity-0" : "opacity-100"
              )}>
                <CustomerDetailContent variant="panel" />
              </div>
            </div>

            {/* Chat — pinned at bottom with resizable handle (same pattern as
             * the task detail panel). Customers only for now; contacts get a
             * provider in a follow-up. Double-click the drag line to collapse
             * / re-open the whole chat section. */}
            {showChat && !chatCollapsed && (
              <div
                className="flex-shrink-0 flex flex-col"
                style={{ height: chatHeight }}
              >
                <div
                  onPointerDown={handleResizePointerDown}
                  onPointerMove={handleResizePointerMove}
                  onPointerUp={handleResizePointerUp}
                  onDoubleClick={() => setChatCollapsed(true)}
                  title={t('sweep.weldcrm.customerDetailView.doubleClickToCloseChat')}
                  className={cn(
                    "relative w-full h-[9px] flex-shrink-0 flex items-center justify-center group touch-none transition-colors cursor-row-resize",
                    hasMessages
                      ? "border-t border-border hover:border-gray-300 dark:hover:border-border"
                      : "border-t border-transparent",
                  )}
                >
                  <div className={cn(
                    "w-8 h-[3px] rounded-full transition-colors",
                    hasMessages && showResizeLine
                      ? "bg-gray-300 dark:bg-border group-hover:bg-gray-400 dark:group-hover:bg-muted-foreground"
                      : hasMessages
                        ? "bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-border"
                        : "bg-transparent",
                  )} />
                </div>
                <div className="flex-1 min-h-0 flex flex-col">
                  <EntityChat
                    entityType={entityType}
                    entityId={customerId}
                    fallbackName={customerName}
                    hideHeader
                  />
                </div>
              </div>
            )}
            {showChat && chatCollapsed && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setChatCollapsed(false)}
                title={t('sweep.weldcrm.customerDetailView.openChat')}
                className="w-full flex flex-col items-center justify-center gap-0.5 pt-[9px] pb-[15px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer border-t border-border hover:border-gray-300 dark:hover:border-border h-auto rounded-none"
              >
                <ChevronUp className="h-4 w-4" />
                <span className="text-[11px] font-medium leading-none">{t('sweep.weldcrm.customerDetailView.openChat')}</span>
              </Button>
            )}
          </>
        )}
      </div>
      <FloatingNoteEditor />
      <FloatingTaskDialog />
    </>
  );
}

function CustomerDetailEmbeddedLayout() {
  const t = useTranslations();
  const { isLoading, error, refresh } = useCustomerDetailContext();

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
        <p className="text-sm text-muted-foreground text-center">{t('sweep.weldcrm.customerDetailContent.failedToLoadContact')}</p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t('sweep.weldcrm.customerDetailView.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <CustomerDetailHeader variant="panel" />

      {/* Tabs + Content */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="relative z-10">
          <CustomerDetailTabs variant="panel" />
        </div>
        <div className={cn(
          "flex-1 overflow-y-auto overflow-x-hidden customer-detail-scroll transition-opacity duration-200",
          isLoading ? "opacity-0" : "opacity-100"
        )}>
          <CustomerDetailContent variant="panel" />
        </div>
      </div>
    </div>
  );
}

/**
 * Floating note editor - Renders the note editor dialog as an overlay
 * triggered from the header's note button without switching tabs.
 */
function FloatingNoteEditor() {
  const t = useTranslations();
  const {
    customerId,
    floatingNote,
    setFloatingNote,
    showFloatingNoteEditor,
    setShowFloatingNoteEditor,
    silentRefresh,
  } = useCustomerDetailContext();

  const updateNoteMutation = useUpdateCustomerNote();
  const deleteNoteMutation = useDeleteCustomerNote();

  const handleSave = React.useCallback(async (content: string) => {
    if (!floatingNote) return;
    await updateNoteMutation.mutateAsync({ noteId: floatingNote.id, customerId, content });
  }, [floatingNote, customerId, updateNoteMutation]);

  const handleDelete = React.useCallback(async () => {
    if (!floatingNote) return;
    try {
      await deleteNoteMutation.mutateAsync({ noteId: floatingNote.id, customerId });
      setShowFloatingNoteEditor(false);
      setFloatingNote(null);
      toast.success(t('sweep.weldcrm.customerDetailView.noteDeleted'));
      silentRefresh();
    } catch {
      toast.error(t('sweep.weldcrm.customerDetailView.failedToDeleteNote'));
    }
  }, [floatingNote, customerId, setShowFloatingNoteEditor, setFloatingNote, silentRefresh, deleteNoteMutation, t]);

  const handleOpenChange = React.useCallback((open: boolean) => {
    setShowFloatingNoteEditor(open);
    if (!open) {
      setFloatingNote(null);
      silentRefresh();
    }
  }, [setShowFloatingNoteEditor, setFloatingNote, silentRefresh]);

  return (
    <NoteEditorDialog
      note={floatingNote}
      open={showFloatingNoteEditor}
      onOpenChange={handleOpenChange}
      onSave={handleSave}
      onDelete={handleDelete}
    />
  );
}

/**
 * Floating task dialog - Renders the create task dialog as an overlay
 * triggered from the header's task button without switching tabs.
 */
function FloatingTaskDialog() {
  const {
    data,
    showTaskDialog,
    setShowTaskDialog,
  } = useCustomerDetailContext();

  const createTaskMutation = useCreateTask();
  const updateTaskMutation = useUpdateTask();

  const customerName = data?.customer
    ? (data.customer.companyName || data.customer.tradingName || data.customer.fullName || `${data.customer.firstName || ''} ${data.customer.lastName || ''}`.trim() || '')
    : '';

  const handleSave = React.useCallback((taskData: Parameters<typeof createTaskMutation.mutate>[0]) => {
    createTaskMutation.mutate(taskData, {
      onSuccess: (result) => {
        if (result.success) {
          setShowTaskDialog(false);
        }
      },
    });
  }, [createTaskMutation, setShowTaskDialog]);

  const handleUpdate = React.useCallback((taskId: string, taskData: Parameters<typeof updateTaskMutation.mutate>[0]['data']) => {
    updateTaskMutation.mutate({ taskId, data: taskData }, {
      onSuccess: () => {
        setShowTaskDialog(false);
      },
    });
  }, [updateTaskMutation, setShowTaskDialog]);

  return (
    <TaskDialog
      open={showTaskDialog}
      onOpenChange={setShowTaskDialog}
      editingTask={null}
      availableAssignees={[]}
      availableCompanies={customerName ? [customerName] : []}
      defaultRecord={customerName || undefined}
      onSave={handleSave}
      onUpdate={handleUpdate}
      isPending={createTaskMutation.isPending || updateTaskMutation.isPending}
    />
  );
}
