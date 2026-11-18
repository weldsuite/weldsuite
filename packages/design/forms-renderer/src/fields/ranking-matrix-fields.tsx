import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { FieldBlockOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';
import { fill, orderedChoices } from '../utils';

export function RankingField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'ranking'>>) {
  const { labels, seed } = useFieldEnv();
  const initial = useMemo(
    () => orderedChoices(field.properties.choices, { randomize: field.properties.randomize }, `${seed}:${field.id}`),
    [field.properties.choices, field.properties.randomize, seed, field.id],
  );
  const byId = new Map(field.properties.choices.map((c) => [c.id, c]));
  const answered = Array.isArray(value) && value.every((id) => typeof id === 'string');
  const order = answered
    ? (value as string[]).map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined)
    : initial;
  const [dragging, setDragging] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);

  function commit(next: typeof order) {
    onChange(next.map((c) => c.id));
  }

  function move(from: number, to: number, focusAfter = false) {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    commit(next);
    if (focusAfter) {
      requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>('[data-wf-rank]')[to]?.focus());
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLLIElement>, index: number) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const to = index + (e.key === 'ArrowDown' ? 1 : -1);
      if (e.altKey || e.shiftKey) move(index, to, true);
      else list.current?.querySelectorAll<HTMLElement>('[data-wf-rank]')[to]?.focus();
    }
  }

  return (
    <div>
      <p className="wf-hint wf-hint-top">{labels.rankingHint}</p>
      <ol
        ref={list}
        id={inputId}
        aria-labelledby={`${inputId}-label`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="wf-ranking"
      >
        {order.map((choice, i) => (
          <li
            key={choice.id}
            tabIndex={0}
            data-wf-rank=""
            data-wf-focus={i === 0 ? '' : undefined}
            data-dragging={dragging === i || undefined}
            className="wf-rank-item"
            draggable
            onKeyDown={(e) => onKeyDown(e, i)}
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', choice.id);
            }}
            onDragOver={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null) move(dragging, i);
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
          >
            <GripVertical className="wf-rank-grip" size={18} aria-hidden="true" />
            <span className="wf-rank-position" aria-hidden="true">
              {i + 1}
            </span>
            <span className="wf-choice-label">{choice.label}</span>
            <span className="wf-rank-buttons">
              <button
                type="button"
                className="wf-icon-button"
                disabled={i === 0}
                aria-label={fill(labels.moveUp, { item: choice.label })}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="wf-icon-button"
                disabled={i === order.length - 1}
                aria-label={fill(labels.moveDown, { item: choice.label })}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDown size={16} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {!answered ? (
        <button type="button" className="wf-link-button" onClick={() => commit(order)}>
          {labels.rankingKeep}
        </button>
      ) : null}
    </div>
  );
}

export function MatrixField({ field, value, onChange, error, inputId, describedBy }: FieldViewProps<FieldBlockOf<'matrix'>>) {
  const { rows, columns, multiple } = field.properties;
  const answer: Record<string, string[]> =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, string[]>) : {};

  function toggle(rowId: string, columnId: string) {
    const current = answer[rowId] ?? [];
    let next: string[];
    if (multiple) next = current.includes(columnId) ? current.filter((c) => c !== columnId) : [...current, columnId];
    else next = current[0] === columnId && current.length === 1 ? current : [columnId];
    const out: Record<string, string[]> = { ...answer };
    if (next.length === 0) delete out[rowId];
    else out[rowId] = next;
    onChange(Object.keys(out).length === 0 ? undefined : out);
  }

  const wrongRow = error?.part;
  return (
    <div className="wf-matrix-scroll">
      <table id={inputId} className="wf-matrix" aria-describedby={describedBy}>
        <thead>
          <tr>
            <td />
            {columns.map((c) => (
              <th key={c.id} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.id} data-invalid={wrongRow === row.id || undefined}>
              <th scope="row">{row.label}</th>
              {columns.map((c, k) => {
                const on = (answer[row.id] ?? []).includes(c.id);
                return (
                  <td key={c.id}>
                    <input
                      type={multiple ? 'checkbox' : 'radio'}
                      name={`${inputId}-${row.id}`}
                      checked={on}
                      aria-label={`${row.label}: ${c.label}`}
                      aria-invalid={wrongRow === row.id ? true : undefined}
                      data-wf-focus={r === 0 && k === 0 ? '' : undefined}
                      className="wf-matrix-input"
                      onChange={() => toggle(row.id, c.id)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
