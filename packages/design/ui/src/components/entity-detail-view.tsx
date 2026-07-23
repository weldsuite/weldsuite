"use client";

import * as React from "react";
import {
  X,
  ChevronLeft,
  Maximize,
  Minimize,
  PanelLeftOpen,
  PanelRightOpen,
} from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./button";

export type EntityDetailMode = "panel" | "fullscreen";

export interface EntityDetailViewProps {
  /**
   * Visual mode. When omitted, the shell starts in `defaultMode` and tracks
   * the mode internally — clicking the expand button toggles between
   * `panel` and `fullscreen`. When provided, the shell is controlled and the
   * caller is responsible for changing it (typically inside `onToggleExpand`).
   */
  mode?: EntityDetailMode;
  defaultMode?: EntityDetailMode;

  // Panel-mode controls (ignored in fullscreen)
  isOpen?: boolean;
  onClose?: () => void;
  onBack?: () => void;
  width?: number | string;
  /** Distance from viewport top (panel mode, and fullscreen-overlay mode). */
  topOffset?: number | string;
  /** Distance from viewport left in fullscreen-overlay mode (default `64px` = platform sidebar). */
  leftOffset?: number | string;
  /**
   * Distance from viewport right. Used by stacked panels so an earlier
   * (deeper) panel can shift left to make room for newer panels pushed on
   * top. Defaults to `0` (the right edge). This offset is applied via
   * `transform: translateX()`, so it animates smoothly with the rest of
   * the panel's transitions.
   */
  rightOffset?: number | string;
  zIndex?: number;

  // Header slots
  title?: React.ReactNode;
  avatar?: React.ReactNode;
  /** Domain-specific buttons rendered before the shell's expand + close controls. */
  actions?: React.ReactNode;

  /**
   * Optional content rendered directly under the header row and above the
   * tab strip. Use this for entity-level editors that belong above the tabs
   * — e.g. the task panel's editable description, a contact's company line,
   * a deal's pipeline-stage chips. Renders flush with the body's left edge.
   */
  subheader?: React.ReactNode;

  /**
   * Expand-button behaviour. If `onToggleExpand` is omitted, the shell flips
   * its own `mode` between panel ↔ fullscreen so the button works out of the
   * box. Pass a callback to take over (e.g. to navigate to a full route).
   * Set `showExpandButton={false}` to hide the button entirely.
   */
  onToggleExpand?: () => void;
  showExpandButton?: boolean;
  showCloseButton?: boolean;

  // Body
  tabs?: React.ReactNode;
  children: React.ReactNode;
  sidebar?: React.ReactNode;

  // Sidebar behaviour
  sidebarDefaultSize?: number;
  sidebarMinSize?: number;
  sidebarMaxSize?: number;
  sidebarPersistKey?: string;
  sidebarDefaultOpen?: boolean;
  /**
   * Panel mode: when true, the bottom sidebar starts collapsed (only the
   * drag bar visible) so heavy embedded UIs (e.g. a chat input that
   * pre-warms the microphone on hover) don't render on first open. Ignored
   * in fullscreen mode — that one uses `sidebarDefaultOpen`.
   */
  sidebarDefaultCollapsed?: boolean;
  /**
   * When `false`, the resize-handle line + top border are visually hidden
   * (the row remains a drag target so the caller can still resize). Used to
   * suppress the divider until there's something worth resizing for — e.g.
   * an empty chat with no messages yet.
   */
  sidebarShowResizeHandle?: boolean;

  /**
   * Lock the sidebar always-open in fullscreen mode — the toggle button is
   * hidden and the open/closed state is no longer persisted. Resize still
   * works. Use for panels where the sidebar is essential context (e.g. the
   * task chat in fullscreen) and should never be dismissed.
   */
  sidebarLocked?: boolean;

  /**
   * When `true`, fullscreen mode renders as a fixed overlay (using
   * `topOffset` + `leftOffset`) regardless of whether `mode` is controlled
   * or uncontrolled. When `false`, fullscreen renders inline (caller is
   * mounting it inside a sized route container). Defaults to `true` for
   * uncontrolled callers (the panel↔fullscreen toggle case) and `false`
   * for controlled callers (route-page case).
   */
  fullscreenOverlay?: boolean;

  // Layout
  loading?: boolean;
  className?: string;
  contentClassName?: string;
}

function toCssLength(value: number | string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return typeof value === "number" ? `${value}px` : value;
}

function readNumberFromStorage(key: string | undefined, fallback: number, min: number): number {
  if (!key || typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(`${key}:size`);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function readBoolFromStorage(key: string | undefined, fallback: boolean): boolean {
  if (!key || typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(`${key}:open`);
  if (raw === null) return fallback;
  return raw === "true";
}

export function EntityDetailView(props: EntityDetailViewProps) {
  const { mode: controlledMode, defaultMode = "panel", onToggleExpand } = props;

  const [internalMode, setInternalMode] = React.useState<EntityDetailMode>(
    controlledMode ?? defaultMode,
  );

  // Mirror the controlled value into internal state so consumers can freely
  // switch between controlled and uncontrolled without losing track.
  React.useEffect(() => {
    if (controlledMode) setInternalMode(controlledMode);
  }, [controlledMode]);

  const activeMode: EntityDetailMode = controlledMode ?? internalMode;

  const handleToggleExpand = React.useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand();
    } else {
      setInternalMode((current) =>
        current === "panel" ? "fullscreen" : "panel",
      );
    }
  }, [onToggleExpand]);

  const isExpanded = activeMode === "fullscreen";

  // If mode is controlled but no onToggleExpand is provided, the expand
  // button has no way to act — hide it unless the caller forces it visible.
  const canExpand = onToggleExpand !== undefined || controlledMode === undefined;
  const sharedHeader: HeaderRenderProps = {
    avatar: props.avatar,
    title: props.title,
    actions: props.actions,
    onBack: props.onBack,
    onClose: props.onClose,
    isExpanded,
    onToggleExpand: handleToggleExpand,
    showExpandButton: props.showExpandButton ?? canExpand,
    showCloseButton: props.showCloseButton ?? true,
  };

  // Non-overlay fullscreen (route-page case) renders inline in the caller's
  // own container. No geometry animation needed.
  const overlay = props.fullscreenOverlay ?? controlledMode === undefined;
  if (isExpanded && !overlay) {
    return <InlineFullscreenLayout {...props} {...sharedHeader} />;
  }

  return <AnimatedShell {...props} {...sharedHeader} mode={activeMode} />;
}

interface HeaderRenderProps {
  avatar?: React.ReactNode;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  onBack?: () => void;
  onClose?: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  showExpandButton: boolean;
  showCloseButton: boolean;
}

function HeaderControls({
  onClose,
  isExpanded,
  onToggleExpand,
  showExpandButton,
  showCloseButton,
}: Pick<
  HeaderRenderProps,
  "onClose" | "isExpanded" | "onToggleExpand" | "showExpandButton" | "showCloseButton"
>) {
  return (
    <div className="flex items-center gap-0.5">
      {showExpandButton && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleExpand}
          aria-label={isExpanded ? "Minimize" : "Expand"}
          title={isExpanded ? "Minimize" : "Expand"}
        >
          {isExpanded ? (
            <Minimize className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Maximize className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      )}
      {showCloseButton && onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
}

function HeaderRow({
  avatar,
  title,
  actions,
  onBack,
  onClose,
  isExpanded,
  onToggleExpand,
  showExpandButton,
  showCloseButton,
}: HeaderRenderProps) {
  return (
    <div className="flex items-center gap-2 px-3 md:px-4 py-[12.5px] flex-shrink-0 min-h-[52px]">
      {onBack && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
        </Button>
      )}
      {avatar && <div className="flex-shrink-0">{avatar}</div>}
      <div className="flex-1 min-w-0">
        {title && <div className="text-[15px] font-medium truncate">{title}</div>}
      </div>
      {actions && (
        <div className="flex items-center gap-0.5 md:gap-1">{actions}</div>
      )}
      <HeaderControls
        onClose={onClose}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        showExpandButton={showExpandButton}
        showCloseButton={showCloseButton}
      />
    </div>
  );
}

type LayoutProps = EntityDetailViewProps & HeaderRenderProps;

/* ---------------------------------------------------------------- */
/*  Unified animated shell                                            */
/*                                                                    */
/*  A single fixed-positioned container whose `left` + `width` are    */
/*  computed from the active mode and smoothly interpolated via CSS   */
/*  transitions. The inner body swaps between panel-layout and        */
/*  fullscreen-layout, but the outer box just morphs its bounds —     */
/*  no cross-fade of differently-shaped contents.                     */
/* ---------------------------------------------------------------- */

function AnimatedShell({
  mode,
  onClose,
  onBack,
  width = 500,
  topOffset = 60,
  leftOffset = 64,
  zIndex = 50,
  title,
  avatar,
  actions,
  isExpanded,
  onToggleExpand,
  showExpandButton,
  showCloseButton,
  subheader,
  tabs,
  children,
  sidebar,
  sidebarDefaultSize,
  sidebarMinSize,
  sidebarMaxSize,
  sidebarPersistKey,
  sidebarDefaultOpen,
  sidebarDefaultCollapsed = false,
  sidebarShowResizeHandle = true,
  sidebarLocked = false,
  loading,
  className,
  contentClassName,
}: LayoutProps & { mode: EntityDetailMode }) {
  const widthCss = toCssLength(width, "500px");
  const topCss = toCssLength(topOffset, "60px");
  const leftOffsetCss = toCssLength(leftOffset, "64px");

  const isFullscreen = mode === "fullscreen";
  const shellRef = React.useRef<HTMLDivElement>(null);

  const header = (
    <HeaderRow
      avatar={avatar}
      title={title}
      actions={actions}
      onBack={onBack}
      onClose={onClose}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      showExpandButton={showExpandButton}
      showCloseButton={showCloseButton}
    />
  );

  // Panel mode renders IN-FLOW inside the shell's panel slot. `ObjectPanelHost`
  // lays the slot out as a flex row next to the module content and owns all
  // spacing (chrome gaps + inter-panel gaps), so the shell just fills its
  // column at the requested width. Fullscreen keeps the fixed overlay below.
  if (!isFullscreen) {
    return (
      <div
        ref={shellRef}
        role="dialog"
        aria-modal="false"
        className={cn(
          // No explicit height — the panel slot (ObjectPanelHost) stretches it
          // to fill the slot's content box (which is offset below the header),
          // so it lines up with the module's white content card.
          "relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background",
          className,
        )}
        style={{ width: widthCss }}
      >
        {header}
        <PanelBody
          shellRef={shellRef}
          subheader={subheader}
          tabs={tabs}
          sidebar={sidebar}
          loading={loading}
          contentClassName={contentClassName}
          sidebarDefaultSize={sidebarDefaultSize ?? 320}
          sidebarMinSize={sidebarMinSize ?? 120}
          sidebarMaxSize={sidebarMaxSize}
          sidebarPersistKey={sidebarPersistKey}
          sidebarDefaultCollapsed={sidebarDefaultCollapsed}
          sidebarShowResizeHandle={sidebarShowResizeHandle}
        >
          {children}
        </PanelBody>
      </div>
    );
  }

  // Fullscreen overlay — a fixed, rounded card sitting exactly over the module
  // content card. Its edges come from `useContentAreaBounds`: `top`/`left` are
  // the content card's origin; the right + bottom insets are CSS vars kept in
  // sync with the card's rect, so the overlay carries the same 8px chrome gap as
  // every other card and shrinks off any open Agent / Calendar / Notifications
  // drawer on the right — no width math, no square edge-to-edge fill.
  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="false"
      className={cn(
        "fixed flex flex-col overflow-hidden rounded-xl bg-background",
        "transition-[right,bottom] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        className,
      )}
      style={{
        top: topCss,
        left: leftOffsetCss,
        right: "var(--object-panel-drawer-inset, 8px)",
        bottom: "var(--object-panel-content-bottom-inset, 8px)",
        zIndex,
      }}
    >
      {header}
      <FullscreenBody
        subheader={subheader}
        tabs={tabs}
        sidebar={sidebar}
        loading={loading}
        contentClassName={contentClassName}
        sidebarDefaultSize={sidebarDefaultSize ?? 500}
        sidebarMinSize={sidebarMinSize ?? 320}
        sidebarMaxSize={sidebarMaxSize ?? 900}
        sidebarPersistKey={sidebarPersistKey}
        sidebarDefaultOpen={sidebarDefaultOpen ?? true}
        sidebarLocked={sidebarLocked}
      >
        {children}
      </FullscreenBody>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Panel-mode body: tabs on top, content fills, bottom sidebar      */
/* ---------------------------------------------------------------- */

interface PanelBodyProps {
  shellRef: React.RefObject<HTMLDivElement | null>;
  subheader?: React.ReactNode;
  tabs?: React.ReactNode;
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  sidebarDefaultSize: number;
  sidebarMinSize: number;
  sidebarMaxSize?: number;
  sidebarPersistKey?: string;
  sidebarDefaultCollapsed: boolean;
  /**
   * Two-state switch driven by the caller (the panels pass `hasMessages`):
   *
   *  - `true`  — a conversation exists. The chat is a resizable region with a
   *    drag handle + divider line, so the user can adjust its height.
   *  - `false` — no messages yet. The chat collapses to just the composer and
   *    the details extend all the way down to the input field. No handle, no
   *    fixed height (there is nothing to resize until a conversation exists).
   */
  sidebarShowResizeHandle?: boolean;
  loading?: boolean;
  contentClassName?: string;
}

function PanelBody({
  shellRef,
  subheader,
  tabs,
  children,
  sidebar,
  sidebarDefaultSize,
  sidebarMinSize,
  sidebarMaxSize,
  sidebarPersistKey,
  sidebarDefaultCollapsed,
  sidebarShowResizeHandle = true,
  loading,
  contentClassName,
}: PanelBodyProps) {
  const [sidebarHeight, setSidebarHeight] = React.useState<number>(() =>
    readNumberFromStorage(sidebarPersistKey, sidebarDefaultSize, sidebarMinSize),
  );
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return sidebarDefaultCollapsed;
    if (!sidebarPersistKey) return sidebarDefaultCollapsed;
    const stored = window.localStorage.getItem(`${sidebarPersistKey}:collapsed`);
    if (stored === null) return sidebarDefaultCollapsed;
    return stored === "1";
  });

  React.useEffect(() => {
    if (!sidebarPersistKey || typeof window === "undefined") return;
    const id = window.setTimeout(() => {
      window.localStorage.setItem(`${sidebarPersistKey}:size`, String(sidebarHeight));
    }, 150);
    return () => window.clearTimeout(id);
  }, [sidebarPersistKey, sidebarHeight]);

  React.useEffect(() => {
    if (!sidebarPersistKey || typeof window === "undefined") return;
    window.localStorage.setItem(`${sidebarPersistKey}:collapsed`, collapsed ? "1" : "0");
  }, [sidebarPersistKey, collapsed]);

  const tabsRowRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef(false);
  const startYRef = React.useRef(0);
  const startHeightRef = React.useRef(0);
  const maxHeightRef = React.useRef<number>(Infinity);
  const rafRef = React.useRef<number | null>(null);
  const pendingHeightRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!sidebar) return;
      e.preventDefault();
      dragRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = sidebarHeight;
      const shell = shellRef.current;
      const tabsEl = tabsRowRef.current;
      const shellHeight = shell?.offsetHeight ?? 800;
      const tabsBottom = tabsEl
        ? tabsEl.getBoundingClientRect().bottom -
          (shell?.getBoundingClientRect().top ?? 0)
        : 80;
      const maxFromTabs = shellHeight - tabsBottom;
      maxHeightRef.current = Math.min(sidebarMaxSize ?? Infinity, maxFromTabs);
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebar, sidebarHeight, shellRef, sidebarMaxSize],
  );

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const delta = startYRef.current - e.clientY;
      const next = Math.max(
        sidebarMinSize,
        Math.min(maxHeightRef.current, startHeightRef.current + delta),
      );
      pendingHeightRef.current = next;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (pendingHeightRef.current !== null) {
          setSidebarHeight(pendingHeightRef.current);
          pendingHeightRef.current = null;
        }
      });
    },
    [sidebarMinSize],
  );

  const handlePointerUp = React.useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingHeightRef.current !== null) {
      setSidebarHeight(pendingHeightRef.current);
      pendingHeightRef.current = null;
    }
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  return (
    <>
      {subheader && (
        <div className="flex-shrink-0">{subheader}</div>
      )}
      {tabs && (
        <div ref={tabsRowRef} className="flex-shrink-0">
          {tabs}
        </div>
      )}

      {/* Details — fill the panel and scroll. With no conversation yet the
          chat below collapses to just the composer, so the details extend all
          the way down to the input field. */}
      <div
        className={cn(
          "flex-1 min-h-0 overflow-y-auto overflow-x-hidden transition-opacity duration-200",
          loading ? "opacity-0" : "opacity-100",
          contentClassName,
        )}
      >
        {children}
      </div>

      {sidebar && (
        // Resizable bottom region with a drag handle so the user can adjust
        // its height (double-click to collapse) — this is what lets the
        // Details list above it grow when it would otherwise be cut off and
        // forced to scroll. The grab line is always visible so the affordance
        // is discoverable regardless of whether a conversation exists yet;
        // `sidebarShowResizeHandle` only controls whether the top border is
        // drawn (e.g. once there are messages).
        <div
          className={cn(
            "relative flex-shrink-0 bg-background flex flex-col",
            !isDragging && "transition-[height] duration-200 ease-out",
          )}
          style={{ height: collapsed ? 8 : sidebarHeight }}
        >
          {!collapsed && (
            <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
          )}
          {/* Full-width resize handle overlaying the top edge. The visible
              horizontal line always spans the panel so it reads as a clear
              divider between the Details list and the chat below; drag it to
              resize, double-click to collapse. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={toggleCollapsed}
            className="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize flex items-center justify-center group z-10"
            title="Drag to resize, double-click to collapse"
          >
            {/* Always-visible full-width divider line. */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-border group-hover:bg-muted-foreground/40 transition-colors pointer-events-none" />
            {/* Centered grab pill — surfaces on hover to signal it's draggable. */}
            <div className="relative h-[3px] w-9 rounded-full bg-transparent group-hover:bg-gray-400 dark:group-hover:bg-muted-foreground/60 transition-colors pointer-events-none" />
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- */
/*  Fullscreen-mode body: tabs + sidebar toggle, content + right     */
/*  sidebar side-by-side.                                            */
/* ---------------------------------------------------------------- */

interface FullscreenBodyProps {
  subheader?: React.ReactNode;
  tabs?: React.ReactNode;
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  sidebarDefaultSize: number;
  sidebarMinSize: number;
  sidebarMaxSize: number;
  sidebarPersistKey?: string;
  sidebarDefaultOpen: boolean;
  sidebarLocked?: boolean;
  loading?: boolean;
  contentClassName?: string;
}

function FullscreenBody({
  subheader,
  tabs,
  children,
  sidebar,
  sidebarDefaultSize,
  sidebarMinSize,
  sidebarMaxSize,
  sidebarPersistKey,
  sidebarDefaultOpen,
  sidebarLocked = false,
  loading,
  contentClassName,
}: FullscreenBodyProps) {
  const [sidebarWidth, setSidebarWidth] = React.useState<number>(() =>
    readNumberFromStorage(sidebarPersistKey, sidebarDefaultSize, sidebarMinSize),
  );
  // When the sidebar is locked open, ignore both the prop default and any
  // persisted "open" flag — the caller has declared the sidebar essential
  // and we don't want a stale localStorage value to hide it.
  const [sidebarOpenRaw, setSidebarOpen] = React.useState<boolean>(() =>
    sidebarLocked ? true : readBoolFromStorage(sidebarPersistKey, sidebarDefaultOpen),
  );
  const sidebarOpen = sidebarLocked ? true : sidebarOpenRaw;

  React.useEffect(() => {
    if (!sidebarPersistKey || typeof window === "undefined") return;
    window.localStorage.setItem(`${sidebarPersistKey}:size`, String(sidebarWidth));
  }, [sidebarPersistKey, sidebarWidth]);

  React.useEffect(() => {
    if (sidebarLocked) return;
    if (!sidebarPersistKey || typeof window === "undefined") return;
    window.localStorage.setItem(`${sidebarPersistKey}:open`, sidebarOpen ? "true" : "false");
  }, [sidebarPersistKey, sidebarOpen, sidebarLocked]);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef(false);

  const handleResizeMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const container = containerRef.current;
      const rightEdge = container
        ? container.getBoundingClientRect().right
        : window.innerWidth;
      const next = Math.max(
        sidebarMinSize,
        Math.min(sidebarMaxSize, rightEdge - e.clientX),
      );
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [sidebarMinSize, sidebarMaxSize]);

  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {subheader && (
        <div className="flex-shrink-0">{subheader}</div>
      )}
      {(tabs || sidebar) && (
        <div className="relative flex-shrink-0">
          {tabs}
          {sidebar && !sidebarLocked && (
            <div className="absolute top-0 right-0 h-full flex items-center pr-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              >
                {sidebarOpen ? (
                  <PanelLeftOpen className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div
            className={cn(
              "flex-1 overflow-y-auto overflow-x-hidden transition-opacity duration-200",
              loading ? "opacity-0" : "opacity-100",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>

        {sidebar && sidebarOpen && (
          <div
            className="relative flex-shrink-0 bg-background border-l border-border flex flex-col"
            style={{ width: sidebarWidth }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
              onMouseDown={handleResizeMouseDown}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 flex items-center justify-center">
                <div className="h-6 w-1 rounded-full bg-transparent group-hover:bg-border transition-colors" />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">{sidebar}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  Inline fullscreen layout: caller renders this inside their own   */
/*  sized route container. No animation, no fixed positioning.       */
/* ---------------------------------------------------------------- */

function InlineFullscreenLayout({
  onClose,
  onBack,
  title,
  avatar,
  actions,
  isExpanded,
  onToggleExpand,
  showExpandButton,
  showCloseButton,
  subheader,
  tabs,
  children,
  sidebar,
  sidebarDefaultSize = 500,
  sidebarMinSize = 320,
  sidebarMaxSize = 900,
  sidebarPersistKey,
  sidebarDefaultOpen = true,
  sidebarLocked = false,
  loading,
  className,
  contentClassName,
}: LayoutProps) {
  return (
    <div className={cn("h-full w-full flex flex-col bg-background", className)}>
      <HeaderRow
        avatar={avatar}
        title={title}
        actions={actions}
        onBack={onBack}
        onClose={onClose}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        showExpandButton={showExpandButton}
        showCloseButton={showCloseButton}
      />
      <FullscreenBody
        subheader={subheader}
        tabs={tabs}
        sidebar={sidebar}
        loading={loading}
        contentClassName={contentClassName}
        sidebarDefaultSize={sidebarDefaultSize}
        sidebarMinSize={sidebarMinSize}
        sidebarMaxSize={sidebarMaxSize}
        sidebarPersistKey={sidebarPersistKey}
        sidebarDefaultOpen={sidebarDefaultOpen}
        sidebarLocked={sidebarLocked}
      >
        {children}
      </FullscreenBody>
    </div>
  );
}
