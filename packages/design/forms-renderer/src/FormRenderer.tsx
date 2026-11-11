import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  blockFields,
  classicPages,
  nextStep,
  type Block,
  type EngineInput,
  type FieldBlock,
  type FormDefinition,
} from '@weldsuite/forms-engine';
import { BlockView, MediaView, type BlockContext } from './blocks';
import { topBlockOfField, useFormCore, type FormCore } from './controller';
import { FieldEnvProvider, type FieldEnv } from './env';
import { Ending, Welcome } from './screens';
import { DEFAULT_THEME, themeStyle } from './theme';
import type { FormRendererLabels, FormRendererProps } from './types';
import { classNames, fill, isEditableTarget, randomSeed, safeRedirectUrl } from './utils';

type Step = { type: 'welcome' } | { type: 'block'; id: string } | { type: 'page'; index: number } | { type: 'empty' };
type Direction = 'forward' | 'back';

function findField(root: HTMLElement | null, fieldId: string): HTMLElement | null {
  if (!root) return null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-field-id]'))) {
    if (el.getAttribute('data-field-id') === fieldId) return el;
  }
  return null;
}

/** Moves focus to the wrong input of a field, else its first input. */
function focusInField(root: HTMLElement | null, fieldId: string): void {
  const field = findField(root, fieldId);
  if (!field) return;
  const target =
    field.querySelector<HTMLElement>('[aria-invalid="true"]:not(div):not(table)') ??
    field.querySelector<HTMLElement>('[data-wf-focus]') ??
    field.querySelector<HTMLElement>('input, textarea, select, button');
  (target ?? field).focus({ preventScroll: false });
  field.scrollIntoView?.({ block: 'center', behavior: 'auto' });
}

function blockMedia(block: Block) {
  return block.type === 'page_break' ? undefined : block.media;
}

/** The page shown: a page index the recomputed path no longer has (answers changed) falls back to the last page. */
function shownPageIndex(step: Step, pageCount: number): number {
  return step.type === 'page' ? Math.min(step.index, Math.max(0, pageCount - 1)) : 0;
}

/** The block on screen: the step's block, or the first block of the page shown. */
function shownBlockId(step: Step, pages: string[][], pageIndex: number): string | null {
  if (step.type === 'block') return step.id;
  if (step.type === 'page') return pages[pageIndex]?.[0] ?? null;
  return null;
}

/** Names what is on screen, so focus moves only when that changes. */
function stepKeyOf(step: Step, pageIndex: number, ended: boolean): string {
  let id: string | number = '';
  if (step.type === 'block') id = step.id;
  else if (step.type === 'page') id = pageIndex;
  return `${step.type}:${id}:${ended ? 'end' : ''}`;
}

/** The fields of the top-level blocks with these ids. */
function fieldsOfBlocks(def: FormDefinition, blockIds: string[]): FieldBlock[] {
  return blockIds.flatMap((id) => {
    const block = def.blocks.find((b) => b.id === id);
    return block ? blockFields(block) : [];
  });
}

/** Where "Next" goes from a block or a page; null when the form is to be submitted. */
function followingStep(def: FormDefinition, step: Step, pageIndex: number, pageCount: number, input: EngineInput): Step | null {
  if (step.type === 'block') {
    const target = nextStep(def, input, step.id);
    return typeof target === 'string' ? { type: 'block', id: target } : null;
  }
  return pageIndex + 1 < pageCount ? { type: 'page', index: pageIndex + 1 } : null;
}

/** The step "Back" returns to: a block, or the page that was shown. */
function historyEntry(step: Step, pageIndex: number): Step {
  return step.type === 'block' ? step : { type: 'page', index: pageIndex };
}

/** Real buttons and links do their own thing on Enter; choice buttons move on instead. */
function actsOnEnter(target: HTMLElement): boolean {
  return target.tagName === 'A' || (target.tagName === 'BUTTON' && !target.hasAttribute('data-wf-choice'));
}

/** The enabled input after `target` in its step, if any. */
function nextInputAfter(root: HTMLElement, target: HTMLElement): HTMLElement | undefined {
  const area = target.closest('.wf-step-content') ?? root;
  const inputs = Array.from(area.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=file]), textarea, select')).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('role') !== 'combobox',
  );
  const at = inputs.indexOf(target);
  return at === -1 ? undefined : inputs[at + 1];
}

/** Zero-based place of the step, for the progress bar and its announcement. */
function progressPosition(classic: boolean, step: Step, pageIndex: number, path: string[], currentBlockId: string | null): number {
  if (classic) return step.type === 'page' ? pageIndex : 0;
  return currentBlockId ? Math.max(0, path.indexOf(currentBlockId)) : 0;
}

function progressPercent(ended: boolean, step: Step, position: number, total: number): number {
  if (ended) return 100;
  if (step.type === 'welcome' || total === 0) return 0;
  return Math.round((position / total) * 100);
}

/** "Page 2 of 5" (classic) or "2 of 7" (conversational). */
function proportionText(labels: FormRendererLabels, classic: boolean, position: number, total: number): string {
  return fill(classic ? labels.pageOf : labels.progressProportion, { current: position + 1, total });
}

/** Whether the step's button submits the form. */
function isLastStep(def: FormDefinition, classic: boolean, step: Step, pageIndex: number, pageCount: number, input: EngineInput): boolean {
  if (classic) return pageIndex + 1 >= pageCount;
  if (step.type === 'empty') return true;
  return step.type === 'block' && typeof nextStep(def, input, step.id) !== 'string';
}

/** The progress bar with its percentage or proportion text; nothing when the form hides it. */
function progressBar(
  mode: FormDefinition['presentation']['progressBar'],
  labels: FormRendererLabels,
  percent: number,
  proportion: string,
): ReactNode {
  if (mode === 'none') return null;
  return (
    <div className="wf-progress">
      <div
        className="wf-progress-track"
        role="progressbar"
        aria-label={labels.progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="wf-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <span className="wf-progress-text">{mode === 'percentage' ? fill(labels.progressPercent, { percent }) : proportion}</span>
    </div>
  );
}

interface ActionsInput {
  classic: boolean;
  labels: FormRendererLabels;
  canGoBack: boolean;
  submitting: boolean;
  buttonLabel: string;
  onBack: () => void;
  onNext: () => void;
}

/** "Back" (classic, after the first page), the step's button and the Enter hint (conversational). */
function stepActions({ classic, labels, canGoBack, submitting, buttonLabel, onBack, onNext }: ActionsInput): ReactNode {
  return (
    <div className="wf-actions">
      {classic && canGoBack ? (
        <button type="button" className="wf-button wf-button-secondary" onClick={onBack}>
          {labels.back}
        </button>
      ) : null}
      <button type={classic ? 'submit' : 'button'} className="wf-button" disabled={submitting} onClick={classic ? undefined : onNext}>
        {buttonLabel}
      </button>
      {classic ? null : <span className="wf-hint wf-enter-hint">{labels.pressEnter}</span>}
    </div>
  );
}

/** One conversational step, with its media beside it (split) or behind it (background image). */
function conversationalStep(block: Block, dir: Direction, ctx: BlockContext, failure: ReactNode, actions: ReactNode): ReactNode {
  const media = blockMedia(block);
  const split = media && (media.placement === 'split_left' || media.placement === 'split_right');
  const background = media && media.placement === 'background' && media.kind === 'image';
  let mediaLayout: string | undefined;
  if (split) mediaLayout = media.placement;
  else if (background) mediaLayout = 'background';
  return (
    <div
      key={`block-${block.id}`}
      className={classNames('wf-step', `wf-anim-${dir}`)}
      data-media={mediaLayout}
      style={background ? { backgroundImage: `url("${media.url.replace(/["\\\n]/g, '')}")` } : undefined}
    >
      {split ? (
        <div className="wf-split-media">
          <MediaView media={media} />
        </div>
      ) : null}
      <div className="wf-step-content">
        <BlockView block={block} ctx={ctx} />
        {failure}
        {actions}
      </div>
    </div>
  );
}

interface StageInput {
  def: FormDefinition;
  core: FormCore;
  step: Step;
  classic: boolean;
  dir: Direction;
  pages: string[][];
  pageIndex: number;
  currentBlock: Block | undefined;
  blockCtx: BlockContext;
  labels: FormRendererLabels;
  redirecting: boolean;
  actions: ReactNode;
  onStart: () => void;
}

/** What the stage shows: the ending, the welcome screen, an empty form's submit, a classic page or one step. */
function stageView(s: StageInput): ReactNode {
  const { def, core, step, labels, actions } = s;
  if (core.ending) {
    return <Ending def={def} state={core.ending} labels={labels} preview={core.preview} redirecting={s.redirecting} />;
  }
  if (step.type === 'welcome' && def.welcome) {
    return <Welcome welcome={def.welcome} labels={labels} rc={core.rc} onStart={s.onStart} />;
  }
  const failure = core.submitFailed ? (
    <p className="wf-error" role="alert">
      {labels.submitFailed}
    </p>
  ) : null;
  if (step.type === 'empty') {
    return (
      <div className="wf-step-content">
        {failure}
        {actions}
      </div>
    );
  }
  if (s.classic) {
    const errorSummary =
      Object.keys(core.errors).length > 0 ? (
        <p className="wf-error" role="alert">
          {labels.fixErrors}
        </p>
      ) : null;
    return (
      <div key={`page-${s.pageIndex}`} className={classNames('wf-page', `wf-anim-${s.dir}`)}>
        {(s.pages[s.pageIndex] ?? []).map((id) => {
          const block = def.blocks.find((b) => b.id === id);
          return block ? <BlockView key={id} block={block} ctx={s.blockCtx} /> : null;
        })}
        {errorSummary}
        {failure}
        {actions}
      </div>
    );
  }
  return s.currentBlock ? conversationalStep(s.currentBlock, s.dir, s.blockCtx, failure, actions) : null;
}

/**
 * The form a respondent fills in: the conversational layout (one step at a
 * time) or the classic one (pages). See ./types.ts for the props and
 * docs/plans/weldforms.md ("Renderer").
 */
export function FormRenderer(props: FormRendererProps) {
  const def = props.definition;
  const { labels, embedded = false } = props;
  const theme = props.theme ?? DEFAULT_THEME;
  const layout = props.layout ?? def.presentation.layout;
  const classic = layout === 'classic';
  const core = useFormCore(props);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [seed] = useState(() => props.seed ?? randomSeed());
  const rootRef = useRef<HTMLDivElement>(null);
  const preview = props.mode === 'preview';
  const pages = useMemo(() => classicPages(def, core.path.path), [def, core.path.path]);

  const firstPath = core.path.path[0];
  const startOf = useCallback((): Step => {
    if (classic) return pages.length > 0 ? { type: 'page', index: 0 } : { type: 'empty' };
    const first = firstPath;
    return first ? { type: 'block', id: first } : { type: 'empty' };
  }, [classic, pages.length, firstPath]);

  const [step, setStep] = useState<Step>(() => {
    if (props.startAtBlockId) {
      const top = topBlockOfField(def, props.startAtBlockId);
      if (top && core.path.path.includes(top.id)) {
        if (!classic) return { type: 'block', id: top.id };
        const index = pages.findIndex((p) => p.includes(top.id));
        if (index !== -1) return { type: 'page', index };
      }
      return startOf();
    }
    if (def.welcome && !props.skipWelcome) return { type: 'welcome' };
    return startOf();
  });
  const [dir, setDir] = useState<Direction>('forward');
  const [historyLength, setHistoryLength] = useState(0);
  const history = useRef<Step[]>([]);
  const busy = useRef(false);
  const pendingFocus = useRef<string | null>(null);
  const [, bump] = useState(0);
  const [announce, setAnnounce] = useState('');
  const mounted = useRef(false);

  const stepBlockId = useCallback(
    (s: Step): string | null => {
      if (s.type === 'block') return s.id;
      if (s.type === 'page') return pages[s.index]?.[0] ?? null;
      return null;
    },
    [pages],
  );

  // Time on the first step starts when the form opens.
  useEffect(() => {
    const id = stepBlockId(step);
    if (id) core.enter(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback(
    (next: Step, direction: Direction) => {
      setDir(direction);
      setStep(next);
      const id = stepBlockId(next);
      if (id) core.enter(id);
    },
    [core, stepBlockId],
  );

  const pageIndex = shownPageIndex(step, pages.length);
  const currentBlockId = shownBlockId(step, pages, pageIndex);
  const currentBlock = step.type === 'block' ? def.blocks.find((b) => b.id === step.id) : undefined;

  const jumpToField = useCallback(
    (fieldId: string) => {
      pendingFocus.current = fieldId;
      const top = topBlockOfField(def, fieldId);
      if (top) {
        if (classic) {
          const index = pages.findIndex((p) => p.includes(top.id));
          if (index !== -1) go({ type: 'page', index }, 'back');
        } else if (core.path.path.includes(top.id)) {
          go({ type: 'block', id: top.id }, 'back');
        }
      }
      bump((n) => n + 1);
    },
    [classic, core.path.path, def, go, pages],
  );

  const advance = useCallback(async () => {
    if (busy.current || core.ending) return;
    busy.current = true;
    try {
      if (step.type === 'welcome') {
        const first = startOf();
        go(first, 'forward');
        return;
      }
      if (step.type === 'empty') {
        const bad = await core.submit();
        if (bad) jumpToField(bad);
        return;
      }

      const fields = fieldsOfBlocks(def, step.type === 'block' ? [step.id] : (pages[pageIndex] ?? []));
      let bad = core.validate(fields);
      if (!bad && core.uploadsPending()) {
        await core.waitForUploads();
        // An upload that finished while we waited may have changed an answer.
        bad = core.validate(fields);
      }
      if (bad) {
        pendingFocus.current = bad;
        bump((n) => n + 1);
        return;
      }
      if (currentBlockId) core.leave(currentBlockId);

      const next = followingStep(def, step, pageIndex, pages.length, { answers: core.answersRef.current, hidden: core.hidden });
      if (next) {
        history.current.push(historyEntry(step, pageIndex));
        setHistoryLength(history.current.length);
        const id = stepBlockId(next);
        if (id) core.reportProgress(id);
        go(next, 'forward');
        return;
      }
      const refused = await core.submit();
      if (refused) jumpToField(refused);
    } finally {
      busy.current = false;
    }
  }, [core, currentBlockId, def, go, jumpToField, pageIndex, pages, startOf, step, stepBlockId]);

  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const autoAdvance = useCallback(() => {
    void advanceRef.current();
  }, []);

  const back = useCallback(() => {
    const previous = history.current.pop();
    setHistoryLength(history.current.length);
    if (!previous) return;
    if (currentBlockId) core.leave(currentBlockId);
    go(previous, 'back');
  }, [core, currentBlockId, go]);

  // Enter moves to the next input of the step, then on. (The classic layout uses the form's own submit.)
  useEffect(() => {
    if (classic) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const root = rootRef.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!root || !target) return;
      const inside = root.contains(target);
      if (!inside && target !== document.body) return;
      if (target instanceof HTMLTextAreaElement && e.shiftKey) return;
      if (inside && actsOnEnter(target)) return;
      e.preventDefault();
      if (inside && isEditableTarget(target) && target.tagName !== 'TEXTAREA') {
        const nextInput = nextInputAfter(root, target);
        if (nextInput) {
          nextInput.focus();
          return;
        }
      }
      void advanceRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [classic]);

  // Focus: a field that needs attention, else the first input of the new step.
  const stepKey = stepKeyOf(step, pageIndex, core.ending !== null);
  const lastStepKey = useRef<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (pendingFocus.current) {
      const id = pendingFocus.current;
      pendingFocus.current = null;
      focusInField(root, id);
      return;
    }
    if (lastStepKey.current === stepKey) return;
    const first = lastStepKey.current === null;
    lastStepKey.current = stepKey;
    if (first && embedded) return;
    if (core.ending) return;
    const target = root.querySelector<HTMLElement>('.wf-stage [data-wf-focus]');
    if (target) target.focus({ preventScroll: true });
    if (!first && classic) root.scrollIntoView?.({ block: 'start' });
  });

  const total = classic ? pages.length : core.path.path.length;
  const position = progressPosition(classic, step, pageIndex, core.path.path, currentBlockId);
  const percent = progressPercent(core.ending !== null, step, position, total);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (step.type === 'welcome' || core.ending || total === 0) return;
    setAnnounce(proportionText(labels, classic, position, total));
  }, [step.type, position, total, core.ending, classic, labels]);

  // The ending: tell the host, and redirect (live only). An unsafe link (a
  // `javascript:` URL from the author) is no redirect at all, whatever the host.
  const endingId = core.ending?.result.ending.id;
  const redirectUrl = safeRedirectUrl(core.ending?.result.ending.redirectUrl);
  const [redirecting, setRedirecting] = useState(false);
  const { onEnding, onRedirect } = props;
  useEffect(() => {
    if (!core.ending) return;
    onEnding?.(core.ending.result);
    if (redirectUrl && !preview && !core.preview) {
      setRedirecting(true);
      if (onRedirect) onRedirect(redirectUrl);
      else window.location.assign(redirectUrl);
    }
    // once per ending
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endingId]);

  const showNumbers = def.presentation.showQuestionNumbers;
  const blockCtx: BlockContext = {
    uid,
    rc: core.rc,
    answers: core.answers,
    errors: core.errors,
    numbers: core.numbering.byField,
    showNumbers,
    onChange: core.setAnswer,
  };

  const loneField = !classic && currentBlock && currentBlock.type !== 'group' && currentBlock.type !== 'statement' && currentBlock.type !== 'page_break';
  const env: FieldEnv = {
    labels,
    seed,
    preview: core.preview,
    conversational: !classic,
    shortcuts: !classic && step.type === 'block' && Boolean(loneField),
    autoAdvance: loneField ? autoAdvance : null,
    onUpload: props.onUpload,
    trackUpload: core.trackUpload,
  };

  // ----- pieces -----
  const progress =
    !core.ending && step.type !== 'welcome' && total > 0
      ? progressBar(def.presentation.progressBar, labels, percent, proportionText(labels, classic, position, total))
      : null;

  const isLast = isLastStep(def, classic, step, pageIndex, pages.length, { answers: core.answers, hidden: core.hidden });
  const buttonLabel = (() => {
    if (core.submitting) return labels.submitting;
    if (isLast) return labels.submit;
    if (currentBlock && currentBlock.type !== 'page_break') {
      if (currentBlock.type === 'statement' || currentBlock.type === 'group') return currentBlock.properties.buttonText || labels.next;
      return labels.ok;
    }
    return labels.next;
  })();

  const actions = stepActions({
    classic,
    labels,
    canGoBack: historyLength > 0,
    submitting: core.submitting,
    buttonLabel,
    onBack: back,
    onNext: () => void advance(),
  });
  const stage = stageView({
    def,
    core,
    step,
    classic,
    dir,
    pages,
    pageIndex,
    currentBlock,
    blockCtx,
    labels,
    redirecting,
    actions,
    onStart: () => void advance(),
  });

  const showBack = !classic && !core.ending && step.type === 'block' && def.presentation.allowBack && historyLength > 0;
  const rootClass = classNames('wf-root', props.className);
  const body = (
    <>
      {theme.background.imageUrl ? <div className="wf-bg" aria-hidden="true" /> : null}
      {progress}
      <main className="wf-stage" data-step={core.ending ? 'ending' : step.type}>
        {stage}
      </main>
      {showBack ? (
        <button type="button" className="wf-back" onClick={back} aria-label={labels.back}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{labels.back}</span>
        </button>
      ) : null}
      {preview ? <span className="wf-preview-badge">{labels.previewBadge}</span> : null}
      <div className="wf-sr-only" aria-live="polite" role="status">
        {announce}
      </div>
    </>
  );

  return (
    <FieldEnvProvider value={env}>
      {classic ? (
        <form
          ref={rootRef as unknown as RefObject<HTMLFormElement>}
          className={rootClass}
          style={themeStyle(theme)}
          data-wf-layout="classic"
          data-wf-align={theme.alignment}
          data-wf-embedded={embedded || undefined}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void advance();
          }}
        >
          {body}
        </form>
      ) : (
        <div
          ref={rootRef}
          className={rootClass}
          style={themeStyle(theme)}
          data-wf-layout="conversational"
          data-wf-align={theme.alignment}
          data-wf-embedded={embedded || undefined}
        >
          {body}
        </div>
      )}
    </FieldEnvProvider>
  );
}

