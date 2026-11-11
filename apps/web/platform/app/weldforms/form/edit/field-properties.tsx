/**
 * The type-specific properties of a field: placeholder and length for text,
 * range for numbers and dates, options for choices, scale settings, matrix
 * rows and columns, file limits and the parts of contact info and address.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { newBlockId, type FieldBlock } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Input } from '@weldsuite/ui/components/input';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useI18n } from '@/lib/i18n/provider';
import { ChoicesEditor } from '../../components/choices-editor';
import { NumberField, OptionSelect, PropSection, ToggleRow } from '../../components/prop-controls';

interface Props {
  field: FieldBlock;
  disabled: boolean;
  /** Patches the field's `properties`; `key` coalesces rapid edits into one undo step. */
  setProps: (patch: Record<string, unknown>, key?: string) => void;
}

export function FieldProperties({ field, disabled, setProps }: Readonly<Props>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const [scoring, setScoring] = useState(false);
  const id = field.id;

  switch (field.type) {
    case 'short_text':
    case 'long_text': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          <FormField label={tp.placeholder}>
            <Input value={p.placeholder ?? ''} onChange={(e) => setProps({ placeholder: e.target.value || undefined }, 'placeholder')} maxLength={200} disabled={disabled} />
          </FormField>
          <NumberField label={tp.maxLength} value={p.maxLength} min={1} max={field.type === 'short_text' ? 1000 : 10000} disabled={disabled} onChange={(maxLength) => setProps({ maxLength }, 'maxLength')} />
        </PropSection>
      );
    }
    case 'email':
    case 'website':
      return (
        <PropSection title={tp.options}>
          <FormField label={tp.placeholder}>
            <Input value={field.properties.placeholder ?? ''} onChange={(e) => setProps({ placeholder: e.target.value || undefined }, 'placeholder')} maxLength={200} disabled={disabled} />
          </FormField>
        </PropSection>
      );
    case 'phone':
      return (
        <PropSection title={tp.options}>
          <FormField label={tp.defaultCountry} helpText={tp.defaultCountryHelp}>
            <Input
              key={field.id}
              defaultValue={field.properties.defaultCountry ?? ''}
              onChange={(e) => {
                const value = e.target.value.trim().toUpperCase();
                if (value === '') setProps({ defaultCountry: undefined }, 'country');
                else if (/^[A-Z]{2}$/.test(value)) setProps({ defaultCountry: value }, 'country');
              }}
              maxLength={2}
              placeholder="NL"
              disabled={disabled}
              className="w-24 uppercase"
            />
          </FormField>
        </PropSection>
      );
    case 'number': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label={tp.min} value={p.min} disabled={disabled} onChange={(min) => setProps({ min }, 'min')} />
            <NumberField label={tp.max} value={p.max} disabled={disabled} onChange={(max) => setProps({ max }, 'max')} />
          </div>
          <NumberField label={tp.decimals} value={p.decimals} min={0} max={6} disabled={disabled} onChange={(decimals) => setProps({ decimals: decimals ?? 0 }, 'decimals')} helpText={tp.decimalsHelp} />
        </PropSection>
      );
    }
    case 'date': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          <OptionSelect
            label={tp.dateFormat}
            value={p.format}
            disabled={disabled}
            options={[
              { value: 'DMY', label: tp.dateFormats.DMY },
              { value: 'MDY', label: tp.dateFormats.MDY },
              { value: 'YMD', label: tp.dateFormats.YMD },
            ]}
            onChange={(format) => setProps({ format })}
          />
          <div className="grid grid-cols-2 gap-2">
            <FormField label={tp.earliest}>
              <Input type="date" value={p.min ?? ''} onChange={(e) => setProps({ min: e.target.value || undefined }, 'min')} disabled={disabled} />
            </FormField>
            <FormField label={tp.latest}>
              <Input type="date" value={p.max ?? ''} onChange={(e) => setProps({ max: e.target.value || undefined }, 'max')} disabled={disabled} />
            </FormField>
          </div>
        </PropSection>
      );
    }
    case 'multiple_choice':
    case 'picture_choice': {
      const p = field.properties;
      const picture = field.type === 'picture_choice';
      const showScoring = scoring || p.choices.some((c) => c.score !== undefined || c.correct !== undefined);
      return (
        <>
          <PropSection title={tp.choices}>
            <ChoicesEditor choices={p.choices} max={picture ? 50 : 200} pictures={picture} scoring={showScoring} disabled={disabled} onChange={(choices, key) => setProps({ choices }, key)} />
            {!showScoring && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setScoring(true)} disabled={disabled}>
                {tp.enableScoring}
              </Button>
            )}
          </PropSection>
          <PropSection title={tp.options}>
            <ToggleRow id={`${id}-multiple`} label={tp.multiple} checked={p.multiple} disabled={disabled} onCheckedChange={(multiple) => setProps({ multiple, ...(multiple ? {} : { minSelections: undefined, maxSelections: undefined }) })} />
            {p.multiple && (
              <div className="grid grid-cols-2 gap-2">
                <NumberField label={tp.minSelections} value={p.minSelections} min={1} disabled={disabled} onChange={(minSelections) => setProps({ minSelections }, 'minSel')} />
                <NumberField label={tp.maxSelections} value={p.maxSelections} min={1} disabled={disabled} onChange={(maxSelections) => setProps({ maxSelections }, 'maxSel')} />
              </div>
            )}
            <ToggleRow id={`${id}-other`} label={tp.allowOther} checked={p.allowOther} disabled={disabled} onCheckedChange={(allowOther) => setProps({ allowOther })} />
            <ToggleRow id={`${id}-random`} label={tp.randomize} checked={p.randomize} disabled={disabled} onCheckedChange={(randomize) => setProps({ randomize })} />
            {field.type === 'picture_choice' && (
              <ToggleRow id={`${id}-labels`} label={tp.showLabels} checked={field.properties.showLabels} disabled={disabled} onCheckedChange={(showLabels) => setProps({ showLabels })} />
            )}
          </PropSection>
        </>
      );
    }
    case 'dropdown': {
      const p = field.properties;
      const showScoring = scoring || p.choices.some((c) => c.score !== undefined || c.correct !== undefined);
      return (
        <>
          <PropSection title={tp.choices}>
            <ChoicesEditor choices={p.choices} max={5000} scoring={showScoring} disabled={disabled} onChange={(choices, key) => setProps({ choices }, key)} />
            {!showScoring && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setScoring(true)} disabled={disabled}>
                {tp.enableScoring}
              </Button>
            )}
          </PropSection>
          <PropSection title={tp.options}>
            <ToggleRow id={`${id}-random`} label={tp.randomize} checked={p.randomize} disabled={disabled} onCheckedChange={(randomize) => setProps({ randomize, ...(randomize ? { alphabetical: false } : {}) })} />
            <ToggleRow id={`${id}-alpha`} label={tp.alphabetical} checked={p.alphabetical} disabled={disabled} onCheckedChange={(alphabetical) => setProps({ alphabetical, ...(alphabetical ? { randomize: false } : {}) })} />
          </PropSection>
        </>
      );
    }
    case 'ranking': {
      const p = field.properties;
      return (
        <>
          <PropSection title={tp.choices}>
            <ChoicesEditor choices={p.choices} max={50} min={2} disabled={disabled} onChange={(choices, key) => setProps({ choices }, key)} />
          </PropSection>
          <PropSection title={tp.options}>
            <ToggleRow id={`${id}-random`} label={tp.randomize} checked={p.randomize} disabled={disabled} onCheckedChange={(randomize) => setProps({ randomize })} />
          </PropSection>
        </>
      );
    }
    case 'rating': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          <NumberField label={tp.steps} value={p.steps} min={3} max={10} disabled={disabled} onChange={(steps) => setProps({ steps: Math.max(3, Math.min(10, steps ?? 5)) }, 'steps')} />
          <OptionSelect
            label={tp.shape}
            value={p.shape}
            disabled={disabled}
            options={(['star', 'heart', 'thumb', 'circle'] as const).map((shape) => ({ value: shape, label: tp.shapes[shape] }))}
            onChange={(shape) => setProps({ shape })}
          />
        </PropSection>
      );
    }
    case 'opinion_scale': {
      const p = field.properties;
      const setLabel = (key: 'left' | 'center' | 'right', value: string) => setProps({ labels: { ...p.labels, [key]: value || undefined } }, `label:${key}`);
      return (
        <PropSection title={tp.options}>
          <div className="grid grid-cols-2 gap-2">
            <OptionSelect label={tp.scaleStart} value={String(p.start) as '0' | '1'} disabled={disabled} options={[{ value: '0', label: '0' }, { value: '1', label: '1' }]} onChange={(v) => setProps({ start: Number(v) })} />
            <NumberField label={tp.scaleEnd} value={p.end} min={5} max={10} disabled={disabled} onChange={(end) => setProps({ end: Math.max(5, Math.min(10, end ?? 10)) }, 'end')} />
          </div>
          {(['left', 'center', 'right'] as const).map((key) => (
            <FormField key={key} label={tp.scaleLabels[key]}>
              <Input value={p.labels[key] ?? ''} onChange={(e) => setLabel(key, e.target.value)} maxLength={100} disabled={disabled} />
            </FormField>
          ))}
        </PropSection>
      );
    }
    case 'nps': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          {(['left', 'right'] as const).map((key) => (
            <FormField key={key} label={tp.scaleLabels[key]}>
              <Input value={p.labels[key] ?? ''} onChange={(e) => setProps({ labels: { ...p.labels, [key]: e.target.value || undefined } }, `label:${key}`)} maxLength={100} disabled={disabled} />
            </FormField>
          ))}
        </PropSection>
      );
    }
    case 'matrix': {
      const p = field.properties;
      const setList = (kind: 'rows' | 'columns', list: Array<{ id: string; label: string }>, key?: string) => setProps({ [kind]: list }, key);
      const editor = (kind: 'rows' | 'columns', prefix: 'r' | 'k', min: number, max: number) => {
        const list = p[kind];
        return (
          <PropSection title={kind === 'rows' ? tp.rows : tp.columns}>
            <ul className="space-y-1.5">
              {list.map((item, index) => (
                <li key={item.id} className="flex items-center gap-1">
                  <Input
                    value={item.label}
                    onChange={(e) => setList(kind, list.map((x) => (x.id === item.id ? { ...x, label: e.target.value } : x)), `${kind}:${item.id}`)}
                    aria-label={`${kind === 'rows' ? tp.row : tp.column} ${index + 1}`}
                    maxLength={500}
                    disabled={disabled}
                    className="h-8"
                  />
                  <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || list.length <= min} onClick={() => setList(kind, list.filter((x) => x.id !== item.id))} aria-label={t.common.actions.remove}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || list.length >= max}
              onClick={() => setList(kind, [...list, { id: newBlockId(prefix), label: `${kind === 'rows' ? tp.row : tp.column} ${list.length + 1}` }])}
            >
              <Plus className="size-4" />
              {kind === 'rows' ? tp.addRow : tp.addColumn}
            </Button>
          </PropSection>
        );
      };
      return (
        <>
          {editor('rows', 'r', 1, 50)}
          {editor('columns', 'k', 2, 20)}
          <PropSection title={tp.options}>
            <ToggleRow id={`${id}-multi`} label={tp.matrixMultiple} checked={p.multiple} disabled={disabled} onCheckedChange={(multiple) => setProps({ multiple })} />
          </PropSection>
        </>
      );
    }
    case 'file_upload': {
      const p = field.properties;
      return (
        <PropSection title={tp.options}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label={tp.maxFiles} value={p.maxFiles} min={1} max={10} disabled={disabled} onChange={(maxFiles) => setProps({ maxFiles: Math.max(1, Math.min(10, maxFiles ?? 1)) }, 'maxFiles')} />
            <NumberField label={tp.maxSizeMb} value={p.maxSizeMb} min={1} max={25} disabled={disabled} onChange={(maxSizeMb) => setProps({ maxSizeMb: Math.max(1, Math.min(25, maxSizeMb ?? 10)) }, 'maxSizeMb')} />
          </div>
          <OptionSelect
            label={tp.accept}
            value={p.accept}
            disabled={disabled}
            options={(['any', 'images', 'documents', 'pdf'] as const).map((accept) => ({ value: accept, label: tp.acceptTypes[accept] }))}
            onChange={(accept) => setProps({ accept })}
          />
        </PropSection>
      );
    }
    case 'contact_info':
    case 'address': {
      const fields = field.properties.fields as Record<string, { enabled: boolean; required: boolean }>;
      const patchPart = (part: string, change: Partial<{ enabled: boolean; required: boolean }>) =>
        setProps({ fields: { ...fields, [part]: { ...fields[part], ...change } } });
      return (
        <PropSection title={tp.parts}>
          <ul className="space-y-1.5">
            {Object.entries(fields).map(([part, config]) => (
              <li key={part} className="flex items-center justify-between gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox checked={config.enabled} onCheckedChange={(checked) => patchPart(part, { enabled: checked === true, ...(checked === true ? {} : { required: false }) })} disabled={disabled} />
                  {(tp.partNames as Record<string, string>)[part] ?? part}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={config.required} onCheckedChange={(checked) => patchPart(part, { required: checked === true })} disabled={disabled || !config.enabled} />
                  {t.weldforms.properties.required}
                </label>
              </li>
            ))}
          </ul>
        </PropSection>
      );
    }
    case 'yes_no':
    case 'legal':
    case 'signature':
      return null;
  }
}
