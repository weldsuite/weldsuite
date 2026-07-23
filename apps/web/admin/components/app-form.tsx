'use client';

import { useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { LucideIconPicker } from './lucide-icon-picker';
import { cn } from '@/lib/utils';

export const APP_CATEGORIES = [
  'Sales & Marketing',
  'Finance',
  'Operations',
  'Productivity',
  'Customer Support',
  'Communication',
  'Infrastructure',
  'Automations',
  'Integrations',
] as const;

export interface AppFormValues {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview: string;
  features: string[];
  howItWorks: { title: string; description: string }[];
  isActive: boolean;
  isPublished: boolean;
  sortOrder: number;
  version: string;
  provider: string;
  verified: boolean;
  releasedAt: string; // YYYY-MM-DD or empty
  websiteUrl: string;
  documentationUrl: string;
  contactUrl: string;
}

export const emptyAppForm: AppFormValues = {
  code: '',
  name: '',
  description: '',
  icon: '',
  category: APP_CATEGORIES[0],
  path: '/',
  overview: '',
  features: [],
  howItWorks: [],
  isActive: true,
  isPublished: false,
  sortOrder: 0,
  version: '1.0.0',
  provider: 'WeldSuite',
  verified: false,
  releasedAt: '',
  websiteUrl: '',
  documentationUrl: '',
  contactUrl: '',
};

interface AppFormProps {
  initial: AppFormValues;
  isEdit?: boolean;
  submitLabel: string;
  onSubmit: (values: AppFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isSubmitting?: boolean;
  errorMessage?: string | null;
}

export function AppForm({
  initial,
  isEdit = false,
  submitLabel,
  onSubmit,
  onCancel,
  isSubmitting,
  errorMessage,
}: AppFormProps) {
  const [values, setValues] = useState<AppFormValues>(initial);
  const [localError, setLocalError] = useState<string | null>(null);

  function set<K extends keyof AppFormValues>(key: K, v: AppFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function validate(): string | null {
    if (!values.code.trim()) return 'Code is required.';
    if (!/^[a-z0-9_-]{2,50}$/.test(values.code)) return 'Code must be 2–50 chars of [a-z0-9_-].';
    if (!values.name.trim()) return 'Name is required.';
    if (!values.description.trim()) return 'Description is required.';
    if (!values.icon.trim()) return 'Icon is required.';
    if (!values.category) return 'Category is required.';
    if (!values.path.startsWith('/')) return 'Path must start with /.';
    for (const [field, label] of [
      ['websiteUrl', 'Website URL'],
      ['documentationUrl', 'Documentation URL'],
      ['contactUrl', 'Contact URL'],
    ] as const) {
      const v = values[field].trim();
      if (!v) continue;
      try {
        new URL(v);
      } catch {
        return `${label} must be a valid URL.`;
      }
    }
    if (values.releasedAt) {
      const d = new Date(values.releasedAt);
      if (Number.isNaN(d.getTime())) return 'Release date must be a valid date.';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setLocalError(err);
      return;
    }
    setLocalError(null);
    await onSubmit(values);
  }

  const error = errorMessage || localError;

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {error && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <Section title="Identity">
        <Field label="Code" required hint="Unique slug used in code (e.g. weldcrm). Cannot be changed casually.">
          <input
            type="text"
            value={values.code}
            onChange={(e) => set('code', e.target.value.toLowerCase())}
            disabled={isEdit}
            className={cn(inputClass, 'font-mono', isEdit && 'opacity-60 cursor-not-allowed')}
            placeholder="weldcrm"
          />
        </Field>

        <Field label="Name" required>
          <input
            type="text"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
            placeholder="WeldCRM"
          />
        </Field>

        <Field label="Description" required hint="Short one-liner shown in catalog listings.">
          <input
            type="text"
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            className={inputClass}
            placeholder="Manage leads, contacts, and sales pipelines"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Path" required hint="URL path inside the platform.">
            <input
              type="text"
              value={values.path}
              onChange={(e) => set('path', e.target.value)}
              className={cn(inputClass, 'font-mono')}
              placeholder="/weldcrm"
            />
          </Field>

          <Field label="Category" required>
            <select
              value={values.category}
              onChange={(e) => set('category', e.target.value)}
              className={inputClass}
            >
              {APP_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Provider">
            <input
              type="text"
              value={values.provider}
              onChange={(e) => set('provider', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Version">
            <input
              type="text"
              value={values.version}
              onChange={(e) => set('version', e.target.value)}
              className={inputClass}
              placeholder="1.0.0"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Release date" hint="Shown next to version on the detail page.">
            <input
              type="date"
              value={values.releasedAt}
              onChange={(e) => set('releasedAt', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Toggle
            label="Verified"
            description="Shows the verified badge next to the app name."
            checked={values.verified}
            onChange={(v) => set('verified', v)}
          />
        </div>
      </Section>

      <Section title="Resources" description="Links shown in the detail page sidebar. Leave blank to hide.">
        <Field label="Website URL">
          <input
            type="url"
            value={values.websiteUrl}
            onChange={(e) => set('websiteUrl', e.target.value)}
            className={inputClass}
            placeholder="https://example.com"
          />
        </Field>
        <Field label="Documentation URL">
          <input
            type="url"
            value={values.documentationUrl}
            onChange={(e) => set('documentationUrl', e.target.value)}
            className={inputClass}
            placeholder="https://docs.example.com"
          />
        </Field>
        <Field label="Contact URL" hint="Use a mailto: link for an email address.">
          <input
            type="url"
            value={values.contactUrl}
            onChange={(e) => set('contactUrl', e.target.value)}
            className={inputClass}
            placeholder="mailto:support@example.com"
          />
        </Field>
      </Section>

      <Section title="Icon">
        <Field label="Lucide icon" required>
          <LucideIconPicker value={values.icon} onChange={(name) => set('icon', name)} />
        </Field>
      </Section>

      <Section title="Detail content" description="Shown on the app's detail page in the App Store.">
        <Field label="Overview" hint="Long description, multi-paragraph supported.">
          <textarea
            value={values.overview}
            onChange={(e) => set('overview', e.target.value)}
            className={cn(inputClass, 'min-h-[140px] resize-y')}
            placeholder="WeldCRM helps you build stronger customer relationships…"
          />
        </Field>

        <Field label="Features">
          <StringListEditor
            items={values.features}
            onChange={(items) => set('features', items)}
            placeholder="Add a feature bullet…"
          />
        </Field>

        <Field label="How it works">
          <HowItWorksEditor
            items={values.howItWorks}
            onChange={(items) => set('howItWorks', items)}
          />
        </Field>
      </Section>

      <Section title="Status">
        <div className="grid grid-cols-2 gap-4">
          <Toggle
            label="Active"
            description="Inactive apps are hidden everywhere."
            checked={values.isActive}
            onChange={(v) => set('isActive', v)}
          />
          <Toggle
            label="Published"
            description="Visible in the App Store."
            checked={values.isPublished}
            onChange={(v) => set('isPublished', v)}
          />
        </div>
        <Field label="Sort order" hint="Lower = appears first.">
          <input
            type="number"
            value={values.sortOrder}
            onChange={(e) => set('sortOrder', Number.parseInt(e.target.value) || 0)}
            className={cn(inputClass, 'w-32')}
          />
        </Field>
      </Section>

      <div className="flex items-center justify-end gap-2 pt-4 border-t">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm hover:bg-accent"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------

const inputClass =
  'w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer p-3 rounded-md border hover:bg-accent/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4"
      />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
    </label>
  );
}

function StringListEditor({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft('');
  }

  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }

  function update(i: number, v: string) {
    onChange(items.map((item, idx) => (idx === i ? v : item)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-6 text-right">{i + 1}.</span>
              <input
                type="text"
                value={item}
                onChange={(e) => update(i, e.target.value)}
                className={inputClass}
              />
              <ReorderButtons onUp={() => move(i, -1)} onDown={() => move(i, 1)} disableUp={i === 0} disableDown={i === items.length - 1} />
              <button
                type="button"
                onClick={() => remove(i)}
                className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                aria-label="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className={inputClass}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="px-3 py-2 rounded-md border text-sm flex items-center gap-1 hover:bg-accent disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>
    </div>
  );
}

function HowItWorksEditor({
  items,
  onChange,
}: {
  items: { title: string; description: string }[];
  onChange: (items: { title: string; description: string }[]) => void;
}) {
  function add() {
    onChange([...items, { title: '', description: '' }]);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function update(i: number, patch: Partial<{ title: string; description: string }>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {items.map((step, i) => (
        <div key={i} className="rounded-md border p-3 space-y-2 bg-muted/30">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">Step {i + 1}</span>
            <div className="flex items-center gap-1">
              <ReorderButtons onUp={() => move(i, -1)} onDown={() => move(i, 1)} disableUp={i === 0} disableDown={i === items.length - 1} />
              <button
                type="button"
                onClick={() => remove(i)}
                className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                aria-label="Remove step"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <input
            type="text"
            value={step.title}
            onChange={(e) => update(i, { title: e.target.value })}
            placeholder="Step title"
            className={inputClass}
          />
          <textarea
            value={step.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="Step description"
            className={cn(inputClass, 'min-h-[60px] resize-y')}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="px-3 py-2 rounded-md border text-sm flex items-center gap-1 hover:bg-accent"
      >
        <Plus className="h-4 w-4" />
        Add step
      </button>
    </div>
  );
}

function ReorderButtons({
  onUp,
  onDown,
  disableUp,
  disableDown,
}: {
  onUp: () => void;
  onDown: () => void;
  disableUp?: boolean;
  disableDown?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onUp}
        disabled={disableUp}
        className="p-1.5 rounded hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="Move up"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={disableDown}
        className="p-1.5 rounded hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="Move down"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
