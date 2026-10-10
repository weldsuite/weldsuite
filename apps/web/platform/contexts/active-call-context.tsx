/**
 * Active call coordinator.
 *
 * A user is in at most ONE live call at a time, across WeldMeet meetings and
 * WeldChat calls. The two call providers cannot see each other (WeldChat wraps
 * WeldMeet), so each registers its live call here, and every way of joining
 * another call asks the coordinator first:
 *
 *   requestSwitch({ target, proceed })
 *     - nothing else is live: `proceed` runs right away;
 *     - a call is live: the global <CallSwitchDialog/> asks. "Leave and join"
 *       LEAVES the live call (never ends it for the others) and then runs
 *       `proceed`; "Stay" runs `onCancel` and nothing changes.
 *
 * "Live" means connecting or connected. A pre-join preview is not live, and a
 * ringing incoming call is not either: only ACCEPTING it asks.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type ActiveCallKind = 'chat' | 'meet';

/** A label, or a function producing it when (and only if) the dialog needs it. */
export type CallLabel = string | (() => string);

/** What a provider registers while its call is live. */
export interface ActiveCallRegistration {
  /** Chat call id (or channel id while connecting), or meeting id. */
  id: string;
  /** What the dialog calls this call, e.g. "the call with Alice". */
  label: CallLabel;
  /** Leave (not end) the call; resolves once the user is out of it. */
  leave: () => Promise<void>;
}

/** The part of a live call other components may look at. */
export interface ActiveCallInfo {
  kind: ActiveCallKind;
  id: string;
}

/** Identifies a live call that is the target itself, so there is nothing to leave. */
export type ActiveCallRef = ActiveCallInfo;

export interface SwitchRequest {
  /** The call the user is trying to join, as the dialog names it. */
  target: { kind: ActiveCallKind; label: CallLabel };
  /** A live call that IS the target: it is not left, and does not need asking about. */
  except?: ActiveCallRef;
  /** Joins the target. Runs once the live call(s) are left, or right away when none is live. */
  proceed: () => void | Promise<void>;
  /** The user chose to stay, or a newer request replaced this one. */
  onCancel?: () => void;
}

/** What the dialog renders. */
export interface SwitchDialogState {
  target: { kind: ActiveCallKind; label: string };
  /** The call(s) that will be left, as one phrase. */
  current: string;
  /** Leaving is in progress: the buttons are locked. */
  switching: boolean;
}

interface CallSwitchApi {
  /**
   * Asks (when a call is live) and then runs `proceed`. Returns a withdraw
   * function: it drops a request that is still waiting, without `onCancel`.
   */
  requestSwitch: (request: SwitchRequest) => () => void;
  /**
   * Same, as a promise for callers that report errors: resolves once `proceed`
   * has finished or the user stayed, rejects with whatever `proceed` throws.
   */
  runWithSwitch: (request: SwitchRequest) => Promise<void>;
}

interface ActiveCallActions extends CallSwitchApi {
  register: (kind: ActiveCallKind, registration: ActiveCallRegistration | null) => void;
  confirmSwitch: () => Promise<void>;
  dismissSwitch: () => void;
}

interface ActiveCallState {
  live: Partial<Record<ActiveCallKind, ActiveCallInfo>>;
  dialog: SwitchDialogState | null;
}

const KINDS: readonly ActiveCallKind[] = ['chat', 'meet'];

const ActiveCallActionsContext = createContext<ActiveCallActions | null>(null);
const ActiveCallStateContext = createContext<ActiveCallState | null>(null);

function resolveLabel(label: CallLabel): string {
  return typeof label === 'function' ? label() : label;
}

function logProceedError(error: unknown) {
  console.error('[CallSwitch] joining the call failed:', error);
}

/** Starts `proceed` synchronously (it may need the click's user activation); errors are logged. */
function runProceed(proceed: SwitchRequest['proceed']) {
  try {
    void Promise.resolve(proceed()).catch(logProceedError);
  } catch (error) {
    logProceedError(error);
  }
}

function isSameCall(call: ActiveCallInfo, ref: ActiveCallRef | undefined): boolean {
  return !!ref && call.kind === ref.kind && call.id === ref.id;
}

/** `runWithSwitch` for a request that is answered by `requestSwitch`. */
function toPromise(
  requestSwitch: CallSwitchApi['requestSwitch'],
  request: SwitchRequest,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    requestSwitch({
      ...request,
      proceed: async () => {
        try {
          await request.proceed();
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      onCancel: () => {
        request.onCancel?.();
        resolve();
      },
    });
  });
}

/** Without a coordinator (preview shells, isolated tests) there is nothing to ask about. */
const STANDALONE_API: CallSwitchApi = {
  requestSwitch: (request) => {
    runProceed(request.proceed);
    return () => undefined;
  },
  runWithSwitch: async (request) => {
    await request.proceed();
  },
};

// ============================================================================
// Provider
// ============================================================================

interface PendingSwitch {
  request: SwitchRequest;
  /** Names of the calls that will be left, captured when the dialog opened. */
  current: string;
  /** The user said "Leave and join"; the request can no longer be withdrawn. */
  confirmed: boolean;
}

interface RegisteredCall extends ActiveCallRegistration {
  kind: ActiveCallKind;
}

export function ActiveCallProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  // The registry is a ref as well as state: `requestSwitch` runs in event
  // handlers right after a provider's status changed, and must not wait for the
  // registration effect's re-render to know a call is live.
  const registryRef = useRef<Partial<Record<ActiveCallKind, RegisteredCall>>>({});
  const [live, setLive] = useState<ActiveCallState['live']>({});
  const [dialog, setDialog] = useState<SwitchDialogState | null>(null);
  const pendingRef = useRef<PendingSwitch | null>(null);

  const register = useCallback((kind: ActiveCallKind, registration: ActiveCallRegistration | null) => {
    if (registration) registryRef.current[kind] = { ...registration, kind };
    else delete registryRef.current[kind];
    setLive((prev) => {
      const current = prev[kind];
      if (!registration) {
        if (!current) return prev;
        const next = { ...prev };
        delete next[kind];
        return next;
      }
      if (current?.id === registration.id) return prev;
      return { ...prev, [kind]: { kind, id: registration.id } };
    });
  }, []);

  /** The registered calls that a request for `except` would have to leave. */
  const callsToLeave = useCallback((except: ActiveCallRef | undefined): RegisteredCall[] => {
    const calls: RegisteredCall[] = [];
    for (const kind of KINDS) {
      const call = registryRef.current[kind];
      if (call && !isSameCall(call, except)) calls.push(call);
    }
    return calls;
  }, []);

  const closeDialog = useCallback((pending: PendingSwitch) => {
    if (pendingRef.current !== pending) return;
    pendingRef.current = null;
    setDialog(null);
  }, []);

  /** A newer request replaces a waiting one; the older one hears it was cancelled. */
  const supersedePending = useCallback(() => {
    const older = pendingRef.current;
    if (!older || older.confirmed) return;
    closeDialog(older);
    older.request.onCancel?.();
  }, [closeDialog]);

  const requestSwitch = useCallback((request: SwitchRequest): (() => void) => {
    supersedePending();

    const calls = callsToLeave(request.except);
    if (calls.length === 0) {
      runProceed(request.proceed);
      return () => undefined;
    }

    const pending: PendingSwitch = {
      request,
      current: calls.map((call) => resolveLabel(call.label)).join(', '),
      confirmed: false,
    };
    pendingRef.current = pending;
    setDialog({
      target: { kind: request.target.kind, label: resolveLabel(request.target.label) },
      current: pending.current,
      switching: false,
    });
    return () => {
      if (!pending.confirmed) closeDialog(pending);
    };
  }, [supersedePending, callsToLeave, closeDialog]);

  const runWithSwitch = useCallback(
    (request: SwitchRequest) => toPromise(requestSwitch, request),
    [requestSwitch],
  );

  const confirmSwitch = useCallback(async () => {
    const pending = pendingRef.current;
    // A double click must not leave (and join) twice.
    if (!pending || pending.confirmed) return;
    pending.confirmed = true;
    setDialog((prev) => (prev ? { ...prev, switching: true } : prev));
    try {
      await Promise.all(callsToLeave(pending.request.except).map((call) => call.leave()));
    } catch (error) {
      // Still in the call, so there is nothing to join.
      console.error('[CallSwitch] leaving the current call failed:', error);
      closeDialog(pending);
      pending.request.onCancel?.();
      return;
    }
    // Closed before `proceed`: joining can take a while and must not sit behind a spinner.
    closeDialog(pending);
    runProceed(pending.request.proceed);
  }, [callsToLeave, closeDialog]);

  const dismissSwitch = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || pending.confirmed) return;
    closeDialog(pending);
    pending.request.onCancel?.();
  }, [closeDialog]);

  // The call being waited on can end by itself (the other side hung up, a
  // second tab left): there is nothing left to leave, so the join just goes ahead.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || pending.confirmed) return;
    if (callsToLeave(pending.request.except).length > 0) return;
    closeDialog(pending);
    runProceed(pending.request.proceed);
  }, [live, callsToLeave, closeDialog]);

  const actions = useMemo<ActiveCallActions>(
    () => ({ register, requestSwitch, runWithSwitch, confirmSwitch, dismissSwitch }),
    [register, requestSwitch, runWithSwitch, confirmSwitch, dismissSwitch],
  );
  const state = useMemo<ActiveCallState>(() => ({ live, dialog }), [live, dialog]);

  return (
    <ActiveCallActionsContext.Provider value={actions}>
      <ActiveCallStateContext.Provider value={state}>{children}</ActiveCallStateContext.Provider>
    </ActiveCallActionsContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * `requestSwitch` / `runWithSwitch`. Falls back to "join right away" when no
 * coordinator is mounted (the WeldChat preview shell, isolated provider tests).
 */
export function useCallSwitchOptional(): CallSwitchApi {
  const actions = useContext(ActiveCallActionsContext);
  return actions ?? STANDALONE_API;
}

/** The live call that is NOT `except`, or null. Re-renders when calls start and end. */
export function useOtherActiveCall(except?: ActiveCallRef): ActiveCallInfo | null {
  const state = useContext(ActiveCallStateContext);
  if (!state) return null;
  for (const kind of KINDS) {
    const call = state.live[kind];
    if (call && !isSameCall(call, except)) return call;
  }
  return null;
}

/**
 * For a call provider: registers `call` while it is live (pass null otherwise).
 * `label` and `leave` are read through refs, so a new closure each render does
 * not re-register; only the id changing does.
 */
export function useRegisterActiveCall(kind: ActiveCallKind, call: ActiveCallRegistration | null): void {
  const actions = useContext(ActiveCallActionsContext);
  const callRef = useRef(call);
  callRef.current = call;
  const id = call?.id ?? null;

  useEffect(() => {
    if (!actions || id === null) return;
    actions.register(kind, {
      id,
      label: () => {
        const label = callRef.current?.label;
        return label === undefined ? '' : resolveLabel(label);
      },
      leave: () => callRef.current?.leave() ?? Promise.resolve(),
    });
    return () => actions.register(kind, null);
  }, [actions, kind, id]);
}

/** For <CallSwitchDialog/>: the open request, and how to answer it. */
export function useCallSwitchDialog() {
  const actions = useContext(ActiveCallActionsContext);
  const state = useContext(ActiveCallStateContext);
  if (!actions || !state) return null;
  return { dialog: state.dialog, confirm: actions.confirmSwitch, dismiss: actions.dismissSwitch };
}
