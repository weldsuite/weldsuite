'use client';

import { useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { LucideIconPicker } from './lucide-icon-picker';

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
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Section title="Identity">
        <Field
          label="Code"
          required
          hint="Unique slug used in code (e.g. weldcrm). Cannot be changed casually."
        >
          <Input
            value={values.code}
            onChange={(e) => set('code', e.target.value.toLowerCase())}
            disabled={isEdit}
            className="font-mono"
            placeholder="weldcrm"
          />
        </Field>

        <Field label="Name" required>
          <Input
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="WeldCRM"
          />
        </Field>

        <Field label="Description" required hint="Short one-liner shown in catalog listings.">
          <Input
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Manage leads, contacts, and sales pipelines"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Path" required hint="URL path inside the platform.">
            <Input
              value={values.path}
              onChange={(e) => set('path', e.target.value)}
              className="font-mono"
              placeholder="/weldcrm"
            />
          </Field>

          <Field label="Category" required>
            <Select value={values.category} onValueChange={(v) => set('category', v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APP_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Provider">
            <Input value={values.provider} onChange={(e) => set('provider', e.target.value)} />
          </Field>
          <Field label="Version">
            <Input
              value={values.version}
              onChange={(e) => set('version', e.target.value)}
              placeholder="1.0.0"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Release date" hint="Shown next to version on the detail page.">
            <Input
              type="date"
              value={values.releasedAt}
              onChange={(e) => set('releasedAt', e.target.value)}
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
          <Input
            type="url"
            value={values.websiteUrl}
            onChange={(e) => set('websiteUrl', e.target.value)}
            placeholder="https://example.com"
          />
        </Field>
        <Field label="Documentation URL">
          <Input
            type="url"
            value={values.documentationUrl}
            onChange={(e) => set('documentationUrl', e.target.value)}
            placeholder="https://docs.example.com"
          />
        </Field>
        <Field label="Contact URL" hint="Use a mailto: link for an email address.">
          <Input
            type="url"
            value={values.contactUrl}
            onChange={(e) => set('contactUrl', e.target.value)}
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
          <Textarea
            value={values.overview}
            onChange={(e) => set('overview', e.target.value)}
            className="min-h-[140px] resize-y"
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
          <Input
            type="number"
            value={values.sortOrder}
            onChange={(e) => set('sortOrder', Number.parseInt(e.target.value) || 0)}
            className="w-32"
          />
        </Field>
      </Section>

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------

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
    <Card className="py-5">
      <CardContent className="space-y-4 px-5">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
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
      <Label className="text-xs font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
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
    <Label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal hover:bg-accent/50">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
    </Label>
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
              <span className="w-6 text-right text-xs text-muted-foreground">{i + 1}.</span>
              <Input value={item} onChange={(e) => update(i, e.target.value)} />
              <ReorderButtons
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                disableUp={i === 0}
                disableDown={i === items.length - 1}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => remove(i)}
                aria-label="Remove"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
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
        <div key={i} className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">Step {i + 1}</span>
            <div className="flex items-center gap-1">
              <ReorderButtons
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                disableUp={i === 0}
                disableDown={i === items.length - 1}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => remove(i)}
                aria-label="Remove step"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Input
            value={step.title}
            onChange={(e) => update(i, { title: e.target.value })}
            placeholder="Step title"
          />
          <Textarea
            value={step.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="Step description"
            className="min-h-[60px] resize-y"
          />
        </div>
      ))}
      <Button type="button" variant="outline" onClick={add}>
        <Plus className="h-4 w-4" />
        Add step
      </Button>
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onUp}
        disabled={disableUp}
        aria-label="Move up"
        className="disabled:opacity-30"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onDown}
        disabled={disableDown}
        aria-label="Move down"
        className="disabled:opacity-30"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
