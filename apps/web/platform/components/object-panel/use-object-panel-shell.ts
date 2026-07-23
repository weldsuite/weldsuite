/**
 * `useObjectPanelShell` — the boring half of every object panel, in one hook.
 *
 * Every panel registered with the object-panel host renders an
 * `EntityDetailView` shell with the same wiring: it tracks a panel↔fullscreen
 * mode (controlled by the host when the panel is on the stack, internal
 * otherwise), measures the platform content area to position the fullscreen
 * overlay, and forwards the stack-driven `rightOffset` so panels cascade.
 *
 * Doing that by hand in every panel (≈40 lines of state + props) is fine
 * for the first three, but it locks the boilerplate in once you have ten
 * panels. Instead each panel calls this hook and spreads the result onto
 * `EntityDetailView`:
 *
 *   const shell = useObjectPanelShell(props);
 *   return (
 *     <EntityDetailView {...shell.entityDetailViewProps} ...>
 *       {body}
 *     </EntityDetailView>
 *   );
 *
 * The hook owns: mode/setMode, content-area bounds, the default
 * `fullscreenOverlay` + `zIndex` choices, and any future shell-wide
 * conventions. Per-panel content (title, avatar, actions, tabs, body,
 * sidebar) stays in the panel.
 */

import { useState, useMemo, useCallback } from 'react';
import type { ComponentProps } from 'react';
import type { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useContentAreaBounds } from './use-content-area-bounds';
import type { ObjectPanelComponentProps } from './types';

type EntityDetailViewProps = ComponentProps<typeof EntityDetailView>;

export interface UseObjectPanelShellOptions
  extends Pick<
    ObjectPanelComponentProps,
    'isOpen' | 'onClose' | 'onBack' | 'mode' | 'onModeChange' | 'rightOffset'
  > {
  /** Panel-mode width in pixels. Defaults to 479 (matches `ObjectPanelHost`). */
  width?: number;
  /** Shows the loading skeleton inside the shell while data fetches. */
  loading?: boolean;
  /** Override the default z-index. The host renders panels above page content
   *  but below truly global overlays — `40` matches the default. */
  zIndex?: number;
  /** Disable the fullscreen overlay behaviour (rarely needed). */
  fullscreenOverlay?: boolean;
}

export interface ObjectPanelShellResult {
  /** Current mode — read this for any panel logic that depends on it
   *  (e.g. choosing sidebar defaults that differ panel↔fullscreen). */
  mode: 'panel' | 'fullscreen';
  /** Imperative setter — flips internal state and notifies the host. */
  setMode: (next: 'panel' | 'fullscreen') => void;
  /**
   * Props ready to spread onto `EntityDetailView`. Covers everything the
   * shell needs to position itself; per-panel content (title/avatar/actions/
   * tabs/children/sidebar) is added by the caller.
   */
  entityDetailViewProps: Pick<
    EntityDetailViewProps,
    | 'mode'
    | 'fullscreenOverlay'
    | 'zIndex'
    | 'onToggleExpand'
    | 'isOpen'
    | 'onClose'
    | 'onBack'
    | 'topOffset'
    | 'leftOffset'
    | 'rightOffset'
    | 'width'
    | 'loading'
  >;
}

const DEFAULT_PANEL_WIDTH = 400;
const DEFAULT_Z_INDEX = 40;

export function useObjectPanelShell({
  isOpen,
  onClose,
  onBack,
  mode: controlledMode,
  onModeChange,
  rightOffset = 0,
  width = DEFAULT_PANEL_WIDTH,
  loading,
  zIndex = DEFAULT_Z_INDEX,
  fullscreenOverlay = true,
}: UseObjectPanelShellOptions): ObjectPanelShellResult {
  const [internalMode, setInternalMode] = useState<'panel' | 'fullscreen'>(
    controlledMode ?? 'panel',
  );
  const mode = controlledMode ?? internalMode;

  const setMode = useCallback(
    (next: 'panel' | 'fullscreen') => {
      if (controlledMode === undefined) setInternalMode(next);
      onModeChange?.(next);
    },
    [controlledMode, onModeChange],
  );

  const onToggleExpand = useCallback(() => {
    setMode(mode === 'panel' ? 'fullscreen' : 'panel');
  }, [mode, setMode]);

  const contentBounds = useContentAreaBounds();

  // Drawer inset (Agent / Calendar / Notifications) lives entirely in a
  // `:root` CSS variable maintained by `useContentAreaBounds` — it
  // doesn't go through React state, so we don't pass it here either.
  // `EntityDetailView` consumes the variable directly inside the
  // panel's non-transitioned `left` calc, so the panel tracks the
  // drawer's open/close in real time without re-rendering.
  const entityDetailViewProps = useMemo<ObjectPanelShellResult['entityDetailViewProps']>(
    () => ({
      mode,
      fullscreenOverlay,
      zIndex,
      onToggleExpand,
      isOpen,
      onClose,
      onBack,
      topOffset: contentBounds.top,
      leftOffset: contentBounds.left,
      rightOffset,
      width,
      loading,
    }),
    [
      mode,
      fullscreenOverlay,
      zIndex,
      onToggleExpand,
      isOpen,
      onClose,
      onBack,
      contentBounds.top,
      contentBounds.left,
      rightOffset,
      width,
      loading,
    ],
  );

  return { mode, setMode, entityDetailViewProps };
}
