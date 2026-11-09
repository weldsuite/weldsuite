import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  blockFields,
  classicPages,
  nextStep,
  type Block,
} from '@weldsuite/forms-engine';
import { BlockView, MediaView, type BlockContext } from './blocks';
import { topBlockOfField, useFormCore } from './controller';
import { FieldEnvProvider, type FieldEnv } from './env';
import { Ending, Welcome } from './screens';
import { DEFAULT_THEME, themeStyle } from './theme';
import type { FormRendererProps } from './types';
import { classNames, fill, isEditableTarget } from './utils';

type Step = { type: 'welcome' } | { type: 'block'; id: string } | { type: 'page'; index: number } | { type: 'empty' };

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
  const [seed] = useState(() => props.seed ?? Math.random().toString(36).slice(2));
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
  const [dir, setDir] = useState<'forward' | 'back'>('forward');
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
    (next: Step, direction: 'forward' | 'back') => {
      setDir(direction);
      setStep(next);
      const id = stepBlockId(next);
      if (id) core.enter(id);
    },
    [core, stepBlockId],
  );

  // A page index the recomputed path no longer has (answers changed) falls back to the last page.
  const pageIndex = step.type === 'page' ? Math.min(step.index, Math.max(0, pages.length - 1)) : 0;
  const currentBlockId = step.type === 'block' ? step.id : step.type === 'page' ? (pages[pageIndex]?.[0] ?? null) : null;
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

      const blockIds = step.type === 'block' ? [step.id] : (pages[pageIndex] ?? []);
      const fields = blockIds.flatMap((id) => {
        const block = def.blocks.find((b) => b.id === id);
        return block ? blockFields(block) : [];
      });
      const bad = core.validate(fields);
      if (bad) {
        pendingFocus.current = bad;
        bump((n) => n + 1);
        return;
      }
      if (core.uploadsPending()) {
        await core.waitForUploads();
        // An upload that finished while we waited may have changed an answer.
        const late = core.validate(fields);
        if (late) {
          pendingFocus.current = late;
          bump((n) => n + 1);
          return;
        }
      }
      if (currentBlockId) core.leave(currentBlockId);

      let next: Step | null = null;
      if (step.type === 'block') {
        const target = nextStep(def, { answers: core.answersRef.current, hidden: core.hidden }, step.id);
        if (typeof target === 'string') next = { type: 'block', id: target };
      } else if (pageIndex + 1 < pages.length) {
        next = { type: 'page', index: pageIndex + 1 };
      }

      if (next) {
        if (step.type === 'block') history.current.push(step);
        else history.current.push({ type: 'page', index: pageIndex });
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
      // Real buttons and links do their own thing; choice buttons move on instead.
      if (inside && (target.tagName === 'A' || (target.tagName === 'BUTTON' && !target.hasAttribute('data-wf-choice')))) return;
      e.preventDefault();
      if (inside && isEditableTarget(target) && target.tagName !== 'TEXTAREA') {
        const area = target.closest('.wf-step-content') ?? root;
        const inputs = Array.from(area.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=file]), textarea, select')).filter(
          (el) => !el.hasAttribute('disabled') && el.getAttribute('role') !== 'combobox',
        );
        const at = inputs.indexOf(target);
        const nextInput = at !== -1 ? inputs[at + 1] : undefined;
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
  const stepKey = `${step.type}:${step.type === 'block' ? step.id : step.type === 'page' ? pageIndex : ''}:${core.ending ? 'end' : ''}`;
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
  const position = classic ? (step.type === 'page' ? pageIndex : 0) : currentBlockId ? Math.max(0, core.path.path.indexOf(currentBlockId)) : 0;
  const percent = core.ending ? 100 : step.type === 'welcome' || total === 0 ? 0 : Math.round((position / total) * 100);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (step.type === 'welcome' || core.ending || total === 0) return;
    setAnnounce(fill(classic ? labels.pageOf : labels.progressProportion, { current: position + 1, total }));
  }, [step.type, position, total, core.ending, classic, labels]);

  // The ending: tell the host, and redirect (live only).
  const endingId = core.ending?.result.ending.id;
  const redirectUrl = core.ending?.result.ending.redirectUrl ?? null;
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
  const progressMode = def.presentation.progressBar;
  const progress =
    progressMode !== 'none' && !core.ending && step.type !== 'welcome' && total > 0 ? (
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
        <span className="wf-progress-text">
          {progressMode === 'percentage'
            ? fill(labels.progressPercent, { percent })
            : fill(classic ? labels.pageOf : labels.progressProportion, { current: position + 1, total })}
        </span>
      </div>
    ) : null;

  const nextState = !classic && step.type === 'block' ? nextStep(def, { answers: core.answers, hidden: core.hidden }, step.id) : null;
  const isLast = classic ? pageIndex + 1 >= pages.length : step.type === 'empty' || (nextState !== null && typeof nextState !== 'string');
  const buttonLabel = (() => {
    if (core.submitting) return labels.submitting;
    if (isLast) return labels.submit;
    if (currentBlock && currentBlock.type !== 'page_break') {
      if (currentBlock.type === 'statement' || currentBlock.type === 'group') return currentBlock.properties.buttonText || labels.next;
      return labels.ok;
    }
    return labels.next;
  })();

  const actions = (
    <div className="wf-actions">
      {classic && historyLength > 0 ? (
        <button type="button" className="wf-button wf-button-secondary" onClick={back}>
          {labels.back}
        </button>
      ) : null}
      <button type={classic ? 'submit' : 'button'} className="wf-button" disabled={core.submitting} onClick={classic ? undefined : () => void advance()}>
        {buttonLabel}
      </button>
      {!classic ? <span className="wf-hint wf-enter-hint">{labels.pressEnter}</span> : null}
    </div>
  );
  const failure = core.submitFailed ? (
    <p className="wf-error" role="alert">
      {labels.submitFailed}
    </p>
  ) : null;
  const errorSummary =
    classic && Object.keys(core.errors).length > 0 ? (
      <p className="wf-error" role="alert">
        {labels.fixErrors}
      </p>
    ) : null;

  let stage: ReactNode;
  if (core.ending) {
    stage = <Ending def={def} state={core.ending} labels={labels} preview={core.preview} redirecting={redirecting} />;
  } else if (step.type === 'welcome' && def.welcome) {
    stage = <Welcome welcome={def.welcome} labels={labels} rc={core.rc} onStart={() => void advance()} />;
  } else if (step.type === 'empty') {
    stage = (
      <div className="wf-step-content">
        {failure}
        {actions}
      </div>
    );
  } else if (classic) {
    stage = (
      <div key={`page-${pageIndex}`} className={classNames('wf-page', `wf-anim-${dir}`)}>
        {(pages[pageIndex] ?? []).map((id) => {
          const block = def.blocks.find((b) => b.id === id);
          return block ? <BlockView key={id} block={block} ctx={blockCtx} /> : null;
        })}
        {errorSummary}
        {failure}
        {actions}
      </div>
    );
  } else if (currentBlock) {
    const media = blockMedia(currentBlock);
    const split = media && (media.placement === 'split_left' || media.placement === 'split_right');
    const background = media && media.placement === 'background' && media.kind === 'image';
    stage = (
      <div
        key={`block-${currentBlock.id}`}
        className={classNames('wf-step', `wf-anim-${dir}`)}
        data-media={split ? media.placement : background ? 'background' : undefined}
        style={background ? { backgroundImage: `url("${media.url.replace(/["\\\n]/g, '')}")` } : undefined}
      >
        {split ? (
          <div className="wf-split-media">
            <MediaView media={media} />
          </div>
        ) : null}
        <div className="wf-step-content">
          <BlockView block={currentBlock} ctx={blockCtx} />
          {failure}
          {actions}
        </div>
      </div>
    );
  } else {
    stage = null;
  }

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

