import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { ChoiceAnswer, FieldBlockOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';
import { choiceLetter, classNames, fill, isEditableTarget, orderedChoices } from '../utils';

const ADVANCE_DELAY_MS = 350;

function readChoice(value: unknown): ChoiceAnswer {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'choiceIds' in value) {
    const v = value as ChoiceAnswer;
    return { choiceIds: Array.isArray(v.choiceIds) ? v.choiceIds : [], ...(typeof v.other === 'string' ? { other: v.other } : {}) };
  }
  return { choiceIds: [] };
}

/** Runs `fn` after a short pause (so the pick is seen), and never after unmount. */
export function useDelayed(fn: (() => void) | null): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (!latest.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current?.(), ADVANCE_DELAY_MS);
  }, []);
}

export function ChoiceField({
  field,
  value,
  onChange,
  error,
  inputId,
  describedBy,
}: FieldViewProps<FieldBlockOf<'multiple_choice' | 'picture_choice'>>) {
  const { labels, seed, shortcuts, autoAdvance } = useFieldEnv();
  const props = field.properties;
  const picture = field.type === 'picture_choice';
  const showLabels = field.type === 'picture_choice' ? field.properties.showLabels : true;
  const multiple = props.multiple;
  const answer = readChoice(value);
  const [otherOn, setOtherOn] = useState(answer.other !== undefined);
  const choices = useMemo(
    () => orderedChoices(props.choices, { randomize: props.randomize }, `${seed}:${field.id}`),
    [props.choices, props.randomize, seed, field.id],
  );
  const selected = new Set(answer.choiceIds);
  const count = answer.choiceIds.length + (otherOn && (answer.other ?? '') !== '' ? 1 : 0);
  const advanceSoon = useDelayed(autoAdvance);
  const group = useRef<HTMLDivElement>(null);

  function emit(ids: string[], other: string | undefined) {
    if (ids.length === 0 && (other === undefined || other === '')) {
      onChange(undefined);
      return;
    }
    onChange(other === undefined || other === '' ? { choiceIds: ids } : { choiceIds: ids, other });
  }

  const pick = useCallback(
    (choiceId: string) => {
      const max = props.maxSelections;
      if (multiple) {
        if (selected.has(choiceId)) emit(answer.choiceIds.filter((id) => id !== choiceId), otherOn ? answer.other : undefined);
        else if (max === undefined || count < max) emit([...answer.choiceIds, choiceId], otherOn ? answer.other : undefined);
        return;
      }
      setOtherOn(false);
      emit([choiceId], undefined);
      advanceSoon();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answer.choiceIds, answer.other, otherOn, multiple, props.maxSelections, count, advanceSoon, onChange],
  );

  const toggleOther = useCallback(() => {
    if (otherOn) {
      setOtherOn(false);
      emit(answer.choiceIds, undefined);
      return;
    }
    const max = props.maxSelections;
    if (multiple && max !== undefined && count >= max) return;
    setOtherOn(true);
    emit(multiple ? answer.choiceIds : [], answer.other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherOn, answer.choiceIds, answer.other, multiple, props.maxSelections, count, onChange]);

  // A, B, C ... pick the choice with that letter (the "Other" option has the next one).
  useEffect(() => {
    if (!shortcuts) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (isEditableTarget(e.target)) return;
      const index = e.key.toUpperCase().charCodeAt(0) - 65;
      if (index < 0 || index > 25) return;
      const choice = choices[index];
      if (choice) {
        e.preventDefault();
        pick(choice.id);
      } else if (index === choices.length && props.allowOther) {
        e.preventDefault();
        toggleOther();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcuts, choices, props.allowOther, pick, toggleOther]);

  function onGroupKey(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'];
    if (!keys.includes(e.key) || isEditableTarget(e.target)) return;
    const items = Array.from(group.current?.querySelectorAll<HTMLElement>('[data-wf-choice]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }

  let hint: string | null = null;
  if (multiple) {
    const { minSelections: min, maxSelections: max } = props;
    if (min !== undefined && max !== undefined) hint = fill(labels.chooseBetween, { min, max });
    else if (max !== undefined) hint = fill(labels.chooseUpTo, { max });
    else if (min !== undefined) hint = fill(labels.chooseAtLeast, { min });
    else hint = labels.chooseAny;
  }

  const role = multiple ? 'checkbox' : 'radio';
  return (
    <div>
      {hint ? <p className="wf-hint wf-hint-top">{hint}</p> : null}
      <div
        ref={group}
        id={inputId}
        role={multiple ? 'group' : 'radiogroup'}
        aria-labelledby={`${inputId}-label`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={classNames('wf-choices', picture && 'wf-choices-picture')}
        onKeyDown={onGroupKey}
      >
        {choices.map((choice, i) => {
          const on = selected.has(choice.id);
          return (
            <button
              key={choice.id}
              type="button"
              role={role}
              aria-checked={on}
              aria-label={picture && !showLabels ? choice.label : undefined}
              data-wf-choice=""
              data-wf-focus={i === 0 ? '' : undefined}
              data-selected={on || undefined}
              className={classNames('wf-choice', picture && 'wf-choice-picture')}
              onClick={() => pick(choice.id)}
            >
              {picture && choice.imageUrl ? <img className="wf-choice-image" src={choice.imageUrl} alt="" loading="lazy" /> : null}
              <span className="wf-choice-row">
                <span className="wf-key" aria-hidden="true">
                  {i < 26 ? choiceLetter(i) : ''}
                </span>
                {showLabels ? <span className="wf-choice-label">{choice.label}</span> : null}
                {on ? <Check className="wf-check" aria-hidden="true" size={16} /> : null}
              </span>
            </button>
          );
        })}
        {props.allowOther ? (
          <div className={classNames('wf-choice wf-choice-other', otherOn && 'wf-choice-other-on')} data-selected={otherOn || undefined}>
            <button type="button" role={role} aria-checked={otherOn} data-wf-choice="" className="wf-choice-other-toggle" onClick={toggleOther}>
              <span className="wf-key" aria-hidden="true">
                {choices.length < 26 ? choiceLetter(choices.length) : ''}
              </span>
              <span className="wf-choice-label">{labels.other}</span>
              {otherOn ? <Check className="wf-check" aria-hidden="true" size={16} /> : null}
            </button>
            {otherOn ? (
              <input
                className="wf-input wf-other-input"
                type="text"
                autoFocus
                aria-label={labels.other}
                placeholder={labels.otherPlaceholder}
                value={answer.other ?? ''}
                onChange={(e) => emit(answer.choiceIds, e.target.value)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DropdownField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'dropdown'>>) {
  const { labels, seed } = useFieldEnv();
  const answer = readChoice(value);
  const choices = useMemo(
    () =>
      orderedChoices(
        field.properties.choices,
        { randomize: field.properties.randomize, alphabetical: field.properties.alphabetical },
        `${seed}:${field.id}`,
      ),
    [field.properties.choices, field.properties.randomize, field.properties.alphabetical, seed, field.id],
  );
  const selectedLabel = choices.find((c) => c.id === answer.choiceIds[0])?.label ?? '';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const filtered = q === '' ? choices : choices.filter((c) => c.label.toLowerCase().includes(q));
  const listId = `${inputId}-list`;
  const activeChoice = filtered[active];

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(id: string) {
    onChange({ choiceIds: [id] });
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = filtered.length;
      if (n > 0) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter' && open) {
      // Picks the highlighted option; the step must not also move on.
      e.preventDefault();
      if (activeChoice) choose(activeChoice.id);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div className="wf-dropdown">
      <input
        id={inputId}
        className="wf-input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeChoice ? `${listId}-${activeChoice.id}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        aria-labelledby={`${inputId}-label`}
        autoComplete="off"
        data-wf-focus=""
        placeholder={selectedLabel || labels.select}
        value={open ? query : selectedLabel}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul ref={list} id={listId} role="listbox" aria-label={labels.search} className="wf-listbox">
          {filtered.length === 0 ? <li className="wf-listbox-empty">{labels.noResults}</li> : null}
          {filtered.map((choice, i) => (
            <li
              key={choice.id}
              id={`${listId}-${choice.id}`}
              role="option"
              aria-selected={choice.id === answer.choiceIds[0]}
              data-active={i === active}
              className="wf-option"
              // mousedown, not click: the input's blur would close the list first
              onMouseDown={(e) => {
                e.preventDefault();
                choose(choice.id);
              }}
              onMouseMove={() => setActive(i)}
            >
              {choice.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function YesNoField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'yes_no' | 'legal'>>) {
  const { labels, shortcuts, autoAdvance } = useFieldEnv();
  const legal = field.type === 'legal';
  const advanceSoon = useDelayed(legal ? null : autoAdvance);
  const current = typeof value === 'boolean' ? value : undefined;

  const set = useCallback(
    (v: boolean) => {
      onChange(v);
      advanceSoon();
    },
    [onChange, advanceSoon],
  );

  useEffect(() => {
    if (!shortcuts) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'y') {
        e.preventDefault();
        set(true);
      } else if (key === 'n') {
        e.preventDefault();
        set(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcuts, set]);

  const options = [
    { v: true, label: legal ? labels.accept : labels.yes, key: 'Y' },
    { v: false, label: legal ? labels.decline : labels.no, key: 'N' },
  ];
  return (
    <div
      id={inputId}
      role="radiogroup"
      aria-labelledby={`${inputId}-label`}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className="wf-choices wf-choices-inline"
    >
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.v}
          data-selected={current === o.v || undefined}
          data-wf-focus={i === 0 ? '' : undefined}
          className="wf-choice"
          onClick={() => set(o.v)}
        >
          <span className="wf-choice-row">
            <span className="wf-key" aria-hidden="true">
              {o.key}
            </span>
            <span className="wf-choice-label">{o.label}</span>
            {current === o.v ? <Check className="wf-check" aria-hidden="true" size={16} /> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
