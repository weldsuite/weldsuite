import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Heart, Star, ThumbsUp } from 'lucide-react';
import type { FieldBlockOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';
import { fill, isEditableTarget } from '../utils';
import { useDelayed } from './choice-fields';

const ICONS = { star: Star, heart: Heart, thumb: ThumbsUp, circle: Circle } as const;

/**
 * Digit keys pick a value: "1" then "0" within a moment make 10. Returns
 * nothing; `values` are the numbers that can be picked.
 */
function useDigitKeys(enabled: boolean, values: number[], pick: (n: number) => void) {
  const buffer = useRef({ text: '', at: 0 });
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !/^\d$/.test(e.key) || isEditableTarget(e.target)) return;
      const now = Date.now();
      const previous = now - buffer.current.at < 700 ? buffer.current.text : '';
      const combined = previous + e.key;
      // The digit joined to the one just typed ("1", "0" → 10) when that is a value, else the digit alone.
      const text = values.includes(Number(combined)) ? combined : e.key;
      if (!values.includes(Number(text))) return;
      e.preventDefault();
      buffer.current = { text, at: now };
      pick(Number(text));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, values, pick]);
}

export function RatingField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'rating'>>) {
  const { labels, shortcuts, autoAdvance } = useFieldEnv();
  const { steps, shape } = field.properties;
  const Icon = ICONS[shape];
  const current = typeof value === 'number' ? value : 0;
  const [hover, setHover] = useState(0);
  const advanceSoon = useDelayed(autoAdvance);
  const values = useMemo(() => Array.from({ length: steps }, (_, i) => i + 1), [steps]);
  const pick = useCallback(
    (n: number) => {
      onChange(n);
      advanceSoon();
    },
    [onChange, advanceSoon],
  );
  useDigitKeys(shortcuts, values, pick);
  const shown = hover || current;
  return (
    <div
      id={inputId}
      role="radiogroup"
      aria-labelledby={`${inputId}-label`}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      className="wf-rating"
      onMouseLeave={() => setHover(0)}
    >
      {values.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={current === n}
          aria-label={fill(labels.ratingOption, { value: n, max: steps })}
          data-wf-focus={n === 1 ? '' : undefined}
          data-on={n <= shown || undefined}
          className="wf-rating-item"
          onClick={() => pick(n)}
          onMouseEnter={() => setHover(n)}
        >
          <Icon size={36} strokeWidth={1.5} aria-hidden="true" />
          <span className="wf-rating-number" aria-hidden="true">
            {n}
          </span>
        </button>
      ))}
    </div>
  );
}

interface NumberScaleProps {
  inputId: string;
  describedBy: string | undefined;
  error: boolean;
  start: number;
  end: number;
  value: unknown;
  labels: { left?: string; center?: string; right?: string };
  onPick: (n: number) => void;
}

function NumberScale({ inputId, describedBy, error, start, end, value, labels, onPick }: NumberScaleProps) {
  const { shortcuts, autoAdvance } = useFieldEnv();
  const advanceSoon = useDelayed(autoAdvance);
  const values = useMemo(() => Array.from({ length: end - start + 1 }, (_, i) => start + i), [start, end]);
  const current = typeof value === 'number' ? value : undefined;
  const pick = useCallback(
    (n: number) => {
      onPick(n);
      advanceSoon();
    },
    [onPick, advanceSoon],
  );
  useDigitKeys(shortcuts, values, pick);
  return (
    <div>
      <div
        id={inputId}
        role="radiogroup"
        aria-labelledby={`${inputId}-label`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="wf-scale"
        style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}
      >
        {values.map((n, i) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={current === n}
            data-selected={current === n || undefined}
            data-wf-focus={i === 0 ? '' : undefined}
            className="wf-scale-item"
            onClick={() => pick(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {labels.left || labels.center || labels.right ? (
        <div className="wf-scale-labels" aria-hidden="true">
          <span>{labels.left}</span>
          <span>{labels.center}</span>
          <span>{labels.right}</span>
        </div>
      ) : null}
    </div>
  );
}

export function OpinionScaleField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'opinion_scale'>>) {
  const { start, end, labels } = field.properties;
  return (
    <NumberScale
      inputId={inputId}
      describedBy={describedBy}
      error={error !== null}
      start={start}
      end={end}
      value={value}
      labels={labels}
      onPick={onChange}
    />
  );
}

export function NpsField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'nps'>>) {
  return (
    <NumberScale
      inputId={inputId}
      describedBy={describedBy}
      error={error !== null}
      start={0}
      end={10}
      value={value}
      labels={field.properties.labels}
      onPick={onChange}
    />
  );
}
