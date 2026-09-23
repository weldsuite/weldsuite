/** Small pieces shared across the WeldHR pages. */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrKpiUnit } from '@weldsuite/app-api-client/domains/weldhr';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useHrEmployees } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Standard page frame: padded, scrollable, max width. */
export function PageBody({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('mx-auto w-full space-y-4 p-6', wide ? 'max-w-7xl' : 'max-w-5xl')}>{children}</div>
    </div>
  );
}

export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words">{error}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function InlineSpinner() {
  return (
    <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** Small labelled number, used on dashboards and summary rows. */
export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warning' | 'danger' | 'success' }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'warning' && 'text-amber-600 dark:text-amber-400',
          tone === 'danger' && 'text-destructive',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` (or ISO) → localised short date. Date-only strings are read as calendar dates, not UTC instants. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** 485 → "8h 05m". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.abs(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatKpiValue(value: number | null | undefined, unit: HrKpiUnit): string {
  if (value === null || value === undefined) return '—';
  switch (unit) {
    case 'percent':
      return `${Math.round(value * 10) / 10}%`;
    case 'seconds': {
      const m = Math.floor(value / 60);
      const s = Math.round(value % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    case 'minutes':
      return formatMinutes(Math.round(value));
    case 'currency':
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    default:
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

type Tone = 'default' | 'secondary' | 'destructive' | 'outline';

const STATUS_TONE: Record<string, Tone> = {
  // employees
  onboarding: 'outline',
  active: 'default',
  on_leave: 'secondary',
  offboarding: 'outline',
  terminated: 'destructive',
  // attendance
  present: 'default',
  late: 'outline',
  absent: 'destructive',
  excused: 'secondary',
  remote: 'secondary',
  half_day: 'secondary',
  // leave
  pending: 'outline',
  approved: 'default',
  rejected: 'destructive',
  cancelled: 'secondary',
  // coaching / evaluations
  open: 'outline',
  acknowledged: 'default',
  closed: 'secondary',
  draft: 'secondary',
  submitted: 'outline',
  // milestones
  planned: 'secondary',
  in_progress: 'outline',
  achieved: 'default',
  missed: 'destructive',
  // checklists / portal
  completed: 'default',
  invited: 'outline',
  revoked: 'destructive',
};

/**
 * Status chip. `group` picks the i18n namespace under `weldhr.status.*`
 * (e.g. `employee`, `attendance`, `leave`), so the same raw value can have a
 * different label in different places.
 */
export function StatusBadge({ group, status }: { group: string; status: string }) {
  const t = useTranslations();
  const label = t(`weldhr.status.${group}.${status}`);
  return <Badge variant={STATUS_TONE[status] ?? 'secondary'}>{label.startsWith('weldhr.') ? status : label}</Badge>;
}

/** Evaluation score 0–100 with a colour band. */
export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <span className="text-muted-foreground">—</span>;
  const tone =
    score >= 85
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : score >= 70
        ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
        : score >= 55
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
  return <span className={cn('inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums', tone)}>{score.toFixed(1)}</span>;
}

export function EmployeeAvatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  return (
    <Avatar className={cn('h-8 w-8', className)}>
      {src && <AvatarImage src={src} alt={name} />}
      <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

interface PickerOption {
  id: string;
  label: string;
  hint?: string | null;
}

function SearchPicker({
  value,
  valueLabel,
  options,
  loading,
  search,
  onSearch,
  onChange,
  placeholder,
  emptyLabel,
  allowClear,
  disabled,
  className,
}: {
  value: string | null | undefined;
  valueLabel?: string | null;
  options: PickerOption[];
  loading: boolean;
  search: string;
  onSearch: (value: string) => void;
  onChange: (id: string | null, option: PickerOption | null) => void;
  placeholder: string;
  emptyLabel: string;
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  const label = selected?.label ?? valueLabel ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !label && 'text-muted-foreground', className)}
        >
          <span className="truncate">{label ?? placeholder}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={onSearch} placeholder={placeholder} />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </div>
            ) : (
              <CommandEmpty>{emptyLabel}</CommandEmpty>
            )}
            {allowClear && value && (
              <CommandItem
                onSelect={() => {
                  onChange(null, null);
                  setOpen(false);
                }}
                className="text-muted-foreground"
              >
                <X className="mr-2 h-4 w-4" />
                —
              </CommandItem>
            )}
            {options.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => {
                  onChange(option.id, option);
                  setOpen(false);
                }}
              >
                <Check className={cn('mr-2 h-4 w-4', option.id === value ? 'opacity-100' : 'opacity-0')} />
                <div className="min-w-0">
                  <p className="truncate">{option.label}</p>
                  {option.hint && <p className="truncate text-xs text-muted-foreground">{option.hint}</p>}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Pick an employee from the WeldHR directory (server-side search). */
export function EmployeePicker({
  value,
  valueLabel,
  onChange,
  placeholder,
  allowClear,
  disabled,
  excludeId,
  className,
}: {
  value: string | null | undefined;
  valueLabel?: string | null;
  onChange: (id: string | null, label: string | null) => void;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  excludeId?: string;
  className?: string;
}) {
  const t = useTranslations();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useHrEmployees({ search: search || undefined, limit: 30, status: 'onboarding,active,on_leave,offboarding' });
  const options = (data?.data ?? [])
    .filter((e) => e.id !== excludeId)
    .map((e) => ({ id: e.id, label: e.displayName, hint: e.jobTitle ?? e.email }));
  return (
    <SearchPicker
      value={value}
      valueLabel={valueLabel}
      options={options}
      loading={isLoading}
      search={search}
      onSearch={setSearch}
      onChange={(id, option) => onChange(id, option?.label ?? null)}
      placeholder={placeholder ?? t('weldhr.common.selectEmployee')}
      emptyLabel={t('weldhr.common.noResults')}
      allowClear={allowClear}
      disabled={disabled}
      className={className}
    />
  );
}

interface CompanyRow {
  id: string;
  displayName?: string | null;
  name?: string | null;
  domain?: string | null;
}

/** Pick a CRM company — the client account. */
export function CompanyPicker({
  value,
  valueLabel,
  onChange,
  placeholder,
  allowClear,
  disabled,
  className,
}: {
  value: string | null | undefined;
  valueLabel?: string | null;
  onChange: (id: string | null, label: string | null) => void;
  placeholder?: string;
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['weldhr', 'company-picker', search],
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams({ limit: '30' });
      if (search) qs.set('search', search);
      return client.get<{ data: CompanyRow[] }>(`/companies?${qs.toString()}`);
    },
    staleTime: 30_000,
  });
  const options = (data?.data ?? []).map((c) => ({ id: c.id, label: c.displayName || c.name || c.id, hint: c.domain ?? null }));
  return (
    <SearchPicker
      value={value}
      valueLabel={valueLabel}
      options={options}
      loading={isLoading}
      search={search}
      onSearch={setSearch}
      onChange={(id, option) => onChange(id, option?.label ?? null)}
      placeholder={placeholder ?? t('weldhr.common.selectClient')}
      emptyLabel={t('weldhr.common.noResults')}
      allowClear={allowClear}
      disabled={disabled}
      className={className}
    />
  );
}

interface PersonRow {
  id: string;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

/** Pick a CRM person linked to a company — a client contact for portal access. */
export function PersonPicker({
  companyId,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  companyId: string | null | undefined;
  value: string | null | undefined;
  onChange: (id: string | null, label: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['weldhr', 'person-picker', companyId, search],
    queryFn: async () => {
      const client = await getClient();
      const qs = new URLSearchParams({ limit: '30', companyId: companyId as string });
      if (search) qs.set('search', search);
      return client.get<{ data: PersonRow[] }>(`/people?${qs.toString()}`);
    },
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
  const options = (data?.data ?? []).map((p) => ({
    id: p.id,
    label: p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || p.id,
    hint: p.email ?? null,
  }));
  return (
    <SearchPicker
      value={value}
      options={options}
      loading={isLoading && Boolean(companyId)}
      search={search}
      onSearch={setSearch}
      onChange={(id, option) => onChange(id, option?.label ?? null)}
      placeholder={placeholder ?? t('weldhr.common.selectContact')}
      emptyLabel={t('weldhr.common.noResults')}
      disabled={disabled || !companyId}
    />
  );
}
