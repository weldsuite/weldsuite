// ============================================================================
// Canvas Utils — pure functions for path derivation, layout, and edges
// ============================================================================

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;
  type: string;
  name: string;
  description?: string;
  order?: number;
  config?: Record<string, unknown>;
  parentBranchId?: string;
  [key: string]: unknown;
}

export interface WorkflowTrigger {
  id?: string;
  type?: string;
  entityType?: string;
  eventType?: string;
  config?: Record<string, unknown>;
  filters?: unknown[];
  [key: string]: unknown;
}

export interface DerivedPath {
  id: string; // 'root' | branchId
  letter: string; // A, B, C, ...
  steps: Array<{ step: WorkflowStep; index: number }>;
  sourceStepId: string | null; // step that creates this branch (null for root)
  sourceType: 'trigger' | 'reply_button' | 'condition';
  sourceLabel: string; // e.g. "Option 1" or "True"
  hasWarning: boolean; // any step unconfigured
  generation: number; // 0 = root, 1 = branches of root, etc.
}

export interface CanvasEdge {
  id: string;
  fromKey: string; // connector key: "trigger:out" or "step:{id}:opt:{value}"
  toKey: string; // connector key: "path:{pathId}:in"
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  trigger: LayoutNode;
  paths: LayoutNode[];
  canvasWidth: number;
  canvasHeight: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const TRIGGER_W = 300;
export const PATH_W = 320;
export const STEP_H = 56;
export const REPLY_BTN_H = 40;
export const BRANCH_LABEL_H = 36;
export const TAB_H = 30;
export const HEADER_H = 48;
export const FOOTER_H = 52;
export const ADD_BTN_ROW_H = 44;
export const COL_GAP = 100;
export const ROW_GAP = 24;
export const PADDING = 80;

// ── Letter generation ──────────────────────────────────────────────────────

function indexToLetter(i: number): string {
  let result = '';
  let n = i;
  while (n >= 0) {
    result = String.fromCodePoint(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

// ── Path height estimation ─────────────────────────────────────────────────

// Extra height a step adds for the reply buttons / branch labels rendered below it
function estimateBranchExtraHeight(step: WorkflowStep): number {
  // Reply buttons below send_choices
  if (step.type === 'send_choices') {
    const opts = Array.isArray(step.config?.options) ? (step.config!.options as unknown[]) : [];
    return opts.length * REPLY_BTN_H + ADD_BTN_ROW_H; // buttons + "+ Add button" row
  }

  // Branch labels below ai_auto_reply (escalated / resolved)
  if (step.type === 'ai_auto_reply') {
    return 2 * BRANCH_LABEL_H;
  }

  // Branch labels below condition
  if (step.type === 'condition') {
    const branches = Array.isArray(step.config?.branches) ? (step.config!.branches as unknown[]) : [];
    const count = branches.length > 0 ? branches.length : 2; // default True/False
    return count * BRANCH_LABEL_H;
  }

  return 0;
}

export function estimatePathHeight(path: DerivedPath): number {
  let h = TAB_H + 16; // tab label above the card + body padding (py-2 = 8px top + 8px bottom)

  for (const { step } of path.steps) {
    h += STEP_H + 4; // step + gap
    h += estimateBranchExtraHeight(step);
  }

  // When path ends with a terminal action, the "Add step" button is rendered
  // above the terminal step and the footer is a small "End of path" label.
  const TERMINAL_ACTIONS = new Set(['send_choices', 'ai_auto_reply']);
  const lastStep = path.steps.length > 0 ? path.steps.at(-1)!.step : null;
  const endsWithTerminal = lastStep ? TERMINAL_ACTIONS.has(lastStep.type) : false;
  if (endsWithTerminal) {
    h += ADD_BTN_ROW_H; // "Add step" button above terminal
    h += 28; // "End of path" footer
  } else {
    h += FOOTER_H; // normal add step footer
  }
  return Math.max(h, TAB_H + FOOTER_H + 20); // minimum height
}

// ── Step warning check ─────────────────────────────────────────────────────

const NO_CONFIG_STEPS = new Set(['ai_auto_reply', 'close_conversation', 'unassign_conversation', 'wait_for_reply']);

function stepHasWarning(step: WorkflowStep): boolean {
  if (NO_CONFIG_STEPS.has(step.type)) return false;
  const config = step.config || {};
  if (Object.keys(config).length === 0) return true;
  if (step.type === 'condition' && !config.expression && !config.field) return true;
  if (step.type === 'delay' && (!config.duration || (config.duration as number) <= 0)) return true;
  return false;
}

// ── Branch definitions ─────────────────────────────────────────────────────

interface BranchDef {
  id: string;
  label: string;
  sourceType: DerivedPath['sourceType'];
  edgeId: string;
  fromKey: string;
}

function getBranchDefs(step: WorkflowStep): BranchDef[] {
  if (step.type === 'send_choices') {
    const opts: Array<{ label?: string; value?: string }> =
      Array.isArray(step.config?.options) ? step.config!.options : [];

    return opts.map((opt, oi) => {
      const branchId = `${step.id}_branch_${opt.value || oi}`;
      return {
        id: branchId,
        label: opt.label || `Option ${oi + 1}`,
        sourceType: 'reply_button' as const,
        edgeId: `edge_${step.id}_opt_${opt.value || oi}_to_${branchId}`,
        fromKey: `step:${step.id}:opt:${opt.value || oi}`,
      };
    });
  }

  let branches: Array<{ id: string; label: string; value: string }> = [];

  // WeldAgent reply branches into escalated/resolved sub-paths
  if (step.type === 'ai_auto_reply') {
    branches = [
      { id: `${step.id}_branch_escalated`, label: 'Escalated', value: 'escalated' },
      { id: `${step.id}_branch_resolved`, label: 'Resolved', value: 'resolved' },
    ];
  } else if (step.type === 'condition') {
    const condBranches: Array<{ value: string; label: string }> =
      Array.isArray(step.config?.branches) ? step.config!.branches : [];
    branches =
      condBranches.length > 0
        ? condBranches.map((b) => ({
            id: `${step.id}_branch_${b.value}`,
            label: b.label,
            value: b.value,
          }))
        : [
            { id: `${step.id}_if`, label: 'True', value: 'if' },
            { id: `${step.id}_if_not`, label: 'False', value: 'if_not' },
          ];
  }

  return branches.map((bd) => ({
    id: bd.id,
    label: bd.label,
    sourceType: 'condition' as const,
    edgeId: `edge_${step.id}_branch_${bd.value}_to_${bd.id}`,
    fromKey: `step:${step.id}:branch:${bd.value}`,
  }));
}

// ── derivePaths ────────────────────────────────────────────────────────────

export function derivePaths(
  steps: WorkflowStep[],
): { paths: DerivedPath[]; edges: CanvasEdge[] } {
  const paths: DerivedPath[] = [];
  const edges: CanvasEdge[] = [];
  let letterIdx = 0;

  function collectBranches(
    parentSteps: Array<{ step: WorkflowStep; index: number }>,
    generation: number,
  ) {
    for (const { step } of parentSteps) {
      for (const def of getBranchDefs(step)) {
        const branchSteps = steps
          .map((s, si) => ({ step: s, index: si }))
          .filter(({ step: s }) => s.parentBranchId === def.id);

        paths.push({
          id: def.id,
          letter: indexToLetter(letterIdx++),
          steps: branchSteps,
          sourceStepId: step.id,
          sourceType: def.sourceType,
          sourceLabel: def.label,
          hasWarning: branchSteps.some(({ step: s }) => stepHasWarning(s)),
          generation,
        });

        edges.push({
          id: def.edgeId,
          fromKey: def.fromKey,
          toKey: `path:${def.id}:in`,
        });

        // Recurse into branch steps
        collectBranches(branchSteps, generation + 1);
      }
    }
  }

  // Root path (A)
  const rootSteps = steps
    .map((s, i) => ({ step: s, index: i }))
    .filter(({ step: s }) => !s.parentBranchId);

  const rootPath: DerivedPath = {
    id: 'root',
    letter: indexToLetter(letterIdx++),
    steps: rootSteps,
    sourceStepId: null,
    sourceType: 'trigger',
    sourceLabel: 'Root',
    hasWarning: rootSteps.some(({ step: s }) => stepHasWarning(s)),
    generation: 0,
  };
  paths.push(rootPath);

  // Edge from trigger to root
  edges.push({
    id: 'edge_trigger_to_root',
    fromKey: 'trigger:out',
    toKey: 'path:root:in',
  });

  // Collect branches from root steps
  collectBranches(rootSteps, 1);

  return { paths, edges };
}

// ── computeLayout ──────────────────────────────────────────────────────────

export function computeLayout(
  paths: DerivedPath[],
): LayoutResult {
  // Group paths by generation
  const genMap = new Map<number, DerivedPath[]>();
  for (const p of paths) {
    const gen = p.generation;
    if (!genMap.has(gen)) genMap.set(gen, []);
    genMap.get(gen)!.push(p);
  }

  const pathLayouts: LayoutNode[] = [];
  let maxRight = 0;
  let maxBottom = 0;

  for (const [gen, genPaths] of genMap.entries()) {
    const colX = PADDING + TRIGGER_W + COL_GAP + gen * (PATH_W + COL_GAP);
    let curY = PADDING;

    for (const p of genPaths) {
      const h = estimatePathHeight(p);
      pathLayouts.push({
        id: p.id,
        x: colX,
        y: curY,
        width: PATH_W,
        height: h,
      });
      curY += h + ROW_GAP;
      maxRight = Math.max(maxRight, colX + PATH_W);
      maxBottom = Math.max(maxBottom, curY);
    }
  }

  // Top-align trigger with paths
  const triggerH = 140;
  const triggerY = PADDING;

  const triggerLayout: LayoutNode = {
    id: 'trigger',
    x: PADDING,
    y: triggerY,
    width: TRIGGER_W,
    height: triggerH,
  };

  return {
    trigger: triggerLayout,
    paths: pathLayouts,
    canvasWidth: maxRight + PADDING + COL_GAP,
    canvasHeight: Math.max(maxBottom + PADDING, triggerY + triggerH + PADDING),
  };
}

// Connector keys (one per reply button / branch label) rendered below a step
interface ConnectorSlots {
  keys: string[];
  itemHeight: number;
  trailingHeight: number; // extra height after the items (e.g. the "+ Add button" row)
}

function getConnectorSlots(step: WorkflowStep): ConnectorSlots | null {
  if (step.type === 'send_choices') {
    const opts = Array.isArray(step.config?.options)
      ? (step.config!.options as Array<{ value?: string }>)
      : [];
    return {
      keys: opts.map((opt, oi) => `step:${step.id}:opt:${opt.value || oi}`),
      itemHeight: REPLY_BTN_H,
      trailingHeight: ADD_BTN_ROW_H,
    };
  }

  if (step.type === 'ai_auto_reply') {
    // WeldAgent reply branch connectors
    return {
      keys: ['escalated', 'resolved'].map((value) => `step:${step.id}:branch:${value}`),
      itemHeight: BRANCH_LABEL_H,
      trailingHeight: 0,
    };
  }

  if (step.type === 'condition') {
    const branches = Array.isArray(step.config?.branches)
      ? (step.config!.branches as Array<{ value: string; label: string }>)
      : [];
    const defs: Array<{ value: string; label: string }> =
      branches.length > 0
        ? branches
        : [{ value: 'if', label: 'True' }, { value: 'if_not', label: 'False' }];
    return {
      keys: defs.map((bd) => `step:${step.id}:branch:${bd.value}`),
      itemHeight: BRANCH_LABEL_H,
      trailingHeight: 0,
    };
  }

  return null;
}

// ── computeConnectorPositions ──────────────────────────────────────────────

export function computeConnectorPositions(
  layout: LayoutResult,
  paths: DerivedPath[],
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();

  // trigger:out → right edge center (offset by TAB_H for the tab label above the card)
  // +DOT_OFFSET so the line reaches the center of the connector dot
  const DOT_OFFSET = 5;
  map.set('trigger:out', {
    x: layout.trigger.x + layout.trigger.width + DOT_OFFSET,
    y: layout.trigger.y + TAB_H + (layout.trigger.height - TAB_H) / 2,
  });

  // Path connectors
  for (const pathLayout of layout.paths) {
    const path = paths.find((p) => p.id === pathLayout.id);
    if (!path) continue;

    // path:{id}:in → left edge, center of card (offset by TAB_H)
    map.set(`path:${path.id}:in`, {
      x: pathLayout.x - DOT_OFFSET,
      y: pathLayout.y + TAB_H + (pathLayout.height - TAB_H) / 2,
    });

    // Compute Y positions for branching connectors inside this path
    let yOffset = TAB_H + 8; // +8 for body py-2 top padding

    for (const { step } of path.steps) {
      yOffset += STEP_H + 4;

      const slots = getConnectorSlots(step);
      if (!slots) continue;

      slots.keys.forEach((key, i) => {
        const slotY = yOffset + i * slots.itemHeight + slots.itemHeight / 2;
        map.set(key, {
          x: pathLayout.x + pathLayout.width + DOT_OFFSET,
          y: pathLayout.y + slotY,
        });
      });
      yOffset += slots.keys.length * slots.itemHeight + slots.trailingHeight;
    }
  }

  return map;
}
