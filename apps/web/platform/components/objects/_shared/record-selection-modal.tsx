/**
 * RecordSelectionModal — pick a company or a person.
 *
 * Lists both kinds in one searchable view backed by app-api
 * (`/api/companies` + `/api/people`). Selection returns a
 * discriminated record; callers branch on `kind`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Loader2, Search, UserPlus, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { companyLogoDomain, useCompanyLogos } from '@/lib/crm/company-logo';
import { RecordKindBadge } from './record-kind-badge';
import type { Person } from '@/hooks/queries/use-people-queries';

export type RecordKind = 'company' | 'person';

export interface SelectableRecord {
  id: string;
  kind: RecordKind;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

interface RecordSelectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectRecord?: (record: SelectableRecord) => void;
  /** Restrict to a single kind. Omit to show both. */
  kind?: RecordKind;
  /** Enable multi-select mode with checkboxes. */
  multiSelect?: boolean;
  /** Called with all selected records when multi-select confirm is clicked. */
  onSelectMultiple?: (records: SelectableRecord[]) => Promise<void> | void;
  /** Record IDs already in the target — shown disabled. */
  existingIds?: string[];
  /** Custom confirm button label for multi-select mode. */
  confirmLabel?: string;
}

interface ApiCompany {
  id: string;
  displayName?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  logoUrl?: string;
  website?: string;
  domain?: string;
}

interface ApiPerson {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatarUrl?: string;
}

/** A listed record; a company without an image of its own carries the domain its logo is looked up by. */
type ListedRecord = SelectableRecord & { logoDomain?: string };

function mapCompany(c: ApiCompany, untitledLabel: string): ListedRecord {
  const displayName = c.displayName || c.name || untitledLabel;
  const avatar = c.avatarUrl || c.logoUrl;
  return {
    id: c.id,
    kind: 'company',
    displayName,
    email: c.email,
    avatarUrl: avatar,
    logoDomain: avatar ? undefined : companyLogoDomain({ website: c.website, domain: c.domain, email: c.email }),
  };
}

function mapPerson(p: ApiPerson, untitledLabel: string): SelectableRecord {
  const displayName =
    p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || untitledLabel;
  return { id: p.id, kind: 'person', displayName, email: p.email, avatarUrl: p.avatarUrl };
}

const RECORD_FETCH_TIMEOUT_MS = 15_000;

/** Rejects when `promise` has not settled within `ms`, so a hung request cannot spin forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Record search timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function recordRowStateClass(isAlready: boolean, isMultiChecked: boolean, isHighlighted: boolean): string {
  if (isAlready) return 'opacity-50 cursor-not-allowed';
  if (isMultiChecked) return 'bg-primary/5 dark:bg-primary/10';
  if (isHighlighted) return 'bg-gray-100/70 dark:bg-secondary/60';
  return 'hover:bg-gray-50 dark:hover:bg-secondary/40';
}

function getInitial(record: SelectableRecord): string {
  return record.displayName.charAt(0).toUpperCase() || '?';
}

export function RecordSelectionModal({
  open,
  onOpenChange,
  onSelectRecord,
  kind,
  multiSelect = false,
  onSelectMultiple,
  existingIds = [],
  confirmLabel,
}: Readonly<RecordSelectionModalProps>) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [records, setRecords] = useState<ListedRecord[]>([]);
  // Logos found on the companies' own websites by our API, not a favicon service.
  const logoDomains = useMemo(() => records.map((r) => r.logoDomain), [records]);
  const logos = useCompanyLogos(logoDomains);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isConfirming, setIsConfirming] = useState(false);
  const [createQuery, setCreateQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleSelection = useCallback(
    (id: string) => {
      if (existingIds.includes(id)) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [existingIds],
  );

  const handleMultiConfirm = async () => {
    if (selectedIds.size === 0 || !onSelectMultiple) return;
    setIsConfirming(true);
    try {
      const picked = records.filter((r) => selectedIds.has(r.id));
      await onSelectMultiple(picked);
      onOpenChange(false);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleSingleSelect = useCallback(
    (record: SelectableRecord) => {
      if (multiSelect) {
        toggleSelection(record.id);
      } else if (onSelectRecord) {
        onSelectRecord(record);
      }
    },
    [multiSelect, onSelectRecord, toggleSelection],
  );

  // The fetch effect must depend only on what changes the query. `getClient`
  // and `t` are read through refs: when either identity changed mid-request the
  // old request was aborted without ever clearing the loading flag, leaving
  // the list stuck on "Searching...".
  const getClientRef = useRef(getClient);
  const tRef = useRef(t);
  useEffect(() => {
    getClientRef.current = getClient;
    tRef.current = t;
  }, [getClient, t]);
  // Only the latest request may touch state; stale or closed-over runs are ignored.
  const fetchSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const seq = ++fetchSeq.current;
    const trimmedQuery = searchQuery.trim();
    setIsLoading(true);
    const fetchRecords = async () => {
      try {
        const client = await getClientRef.current();
        const searchParam = trimmedQuery ? `&search=${encodeURIComponent(trimmedQuery)}` : '';
        // Without a search the API returns the most recently created first, so
        // an empty query shows recent companies and people.
        const request = Promise.all([
          kind === 'person'
            ? Promise.resolve({ data: [] as ApiCompany[] })
            : client.get<{ data?: ApiCompany[] }>(`/companies?limit=50${searchParam}`),
          kind === 'company'
            ? Promise.resolve({ data: [] as ApiPerson[] })
            // inCrm=true matches the People table's own filter — mail/helpdesk
            // auto-create contacts with inCrm=false so they don't clutter
            // record pickers like this one either.
            : client.get<{ data?: ApiPerson[] }>(`/people?limit=50&inCrm=true${searchParam}`),
        ]);
        const [companiesRes, peopleRes] = await withTimeout(request, RECORD_FETCH_TIMEOUT_MS);
        if (seq !== fetchSeq.current) return;
        const untitledCompanyLabel = tRef.current('sweep.entities.untitledCompany');
        const untitledPersonLabel = tRef.current('sweep.entities.untitledPerson');
        const next: ListedRecord[] = [
          ...(companiesRes.data ?? []).map((c) => mapCompany(c, untitledCompanyLabel)),
          ...(peopleRes.data ?? []).map((p) => mapPerson(p, untitledPersonLabel)),
        ];
        setRecords(next);
      } catch (err) {
        if (seq === fetchSeq.current) {
          console.error('Failed to fetch records:', err);
          setRecords([]);
        }
      } finally {
        if (seq === fetchSeq.current) setIsLoading(false);
      }
    };
    // Debounce typing, but load the recent records right away on open.
    const timeoutId = setTimeout(fetchRecords, trimmedQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery, open, kind]);

  useEffect(() => {
    if (!open) {
      // Drop any in-flight request so it cannot leave the list "loading".
      fetchSeq.current++;
      setIsLoading(false);
      setSearchQuery('');
      setSelectedIndex(0);
      setKeyboardActive(false);
      setSelectedIds(new Set());
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open || createQuery) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setKeyboardActive(true);
        setSelectedIndex((prev) => Math.min(prev + 1, records.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setKeyboardActive(true);
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const record = records[selectedIndex];
        if (record) handleSingleSelect(record);
        else if (kind !== 'company' && searchQuery.trim()) setCreateQuery(searchQuery.trim());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, selectedIndex, records, onSelectRecord, handleSingleSelect, kind, searchQuery, createQuery]);

  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      selected?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  let title: string;
  let placeholder: string;
  if (kind === 'company') {
    title = t('sweep.entities.chooseCompany');
    placeholder = t('sweep.entities.searchCompaniesPlaceholder');
  } else if (kind === 'person') {
    title = t('sweep.entities.choosePerson');
    placeholder = t('sweep.entities.searchPeoplePlaceholder');
  } else {
    title = t('sweep.entities.chooseRecord');
    placeholder = t('sweep.entities.searchCompaniesAndPeoplePlaceholder');
  }
  const resolvedConfirmLabel = confirmLabel ?? t('sweep.entities.addToList');
  const canCreatePerson = kind !== 'company' && searchQuery.trim().length > 0;

  const handlePersonCreated = (person: Person) => {
    const record: SelectableRecord = {
      id: person.id,
      kind: 'person',
      displayName: person.displayName || person.email || t('sweep.entities.untitledPerson'),
      email: person.email ?? undefined,
      avatarUrl: person.avatarUrl ?? undefined,
    };
    setRecords((prev) => [record, ...prev.filter((r) => r.id !== person.id)]);
    setSearchQuery('');
    if (multiSelect) {
      setSelectedIds((prev) => new Set(prev).add(person.id));
    } else {
      onSelectRecord?.(record);
    }
  };

  const createPersonButton = canCreatePerson ? (
    <Button
      variant="ghost"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setCreateQuery(searchQuery.trim())}
      className="w-full justify-start gap-2 px-4 py-2 text-left font-normal"
    >
      <UserPlus className="h-4 w-4 text-muted-foreground" />
      <span className="truncate">
        {t('sweep.entities.createPersonFromSearch', { name: searchQuery.trim() })}
      </span>
    </Button>
  ) : null;

  let listContent: ReactNode;
  if (isLoading && records.length === 0) {
    listContent = (
      <div className="flex items-center justify-center py-12 gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('sweep.entities.searchingEllipsis')}</p>
      </div>
    );
  } else if (records.length === 0) {
    listContent = (
      <div className="h-full text-center flex flex-col items-center justify-center gap-3 pb-12">
        <p className="text-sm text-muted-foreground">
          {searchQuery
            ? t('sweep.entities.noResultsFoundFor', { query: searchQuery })
            : t('sweep.entities.noRecordsFound')}
        </p>
        {createPersonButton}
      </div>
    );
  } else {
    listContent = (
      <div ref={listRef} className={cn('flex flex-col gap-0.5', isLoading && 'opacity-60')}>
        {records.map((record, index) => {
          const isAlready = existingIds.includes(record.id);
          const isChecked = selectedIds.has(record.id);
          return (
          <Button
            key={`${record.kind}-${record.id}`}
            variant="ghost"
            disabled={isAlready}
            className={cn(
              'group w-full h-auto flex items-center justify-start gap-2.5 min-w-0 px-4 py-1.5 transition-colors text-left font-normal',
              recordRowStateClass(isAlready, multiSelect && isChecked, keyboardActive && selectedIndex === index),
            )}
            onMouseEnter={() => {
              setKeyboardActive(false);
              setSelectedIndex(index);
            }}
            onClick={() => handleSingleSelect(record)}
          >
            {multiSelect && (
              <Checkbox
                checked={isAlready || isChecked}
                className="pointer-events-none flex-shrink-0 rounded-[5px] data-[state=checked]:bg-primary data-[state=checked]:border-primary"
              />
            )}
            <div className="pointer-events-none flex items-center gap-1.5 min-w-0 flex-1">
              <Avatar className="h-[22px] w-[22px] rounded-md border border-border flex-shrink-0">
                <AvatarImage src={record.avatarUrl ?? (record.logoDomain ? logos.get(record.logoDomain) : undefined)} />
                <AvatarFallback className="rounded-md bg-muted text-[10px] font-medium">
                  {getInitial(record)}
                </AvatarFallback>
              </Avatar>
              <span className="font-medium text-[14px] text-foreground group-hover:text-primary truncate min-w-0">
                {record.displayName}
              </span>
            </div>

            {record.email && (
              <span className="pointer-events-none text-[12px] text-muted-foreground truncate flex-shrink-0 max-w-[40%]">
                {record.email}
              </span>
            )}

            {!kind && <RecordKindBadge kind={record.kind} className="pointer-events-none" />}
          </Button>
          );
        })}
        {createPersonButton}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] w-[560px] max-h-[600px] h-[600px] p-0 gap-0 overflow-hidden rounded-xl [&>button]:hidden flex flex-col">
        <div className="flex items-center justify-between pl-4 pr-2.5 pt-4 pb-0">
          <DialogTitle className="text-[17px] font-semibold">{title}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-4 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              type="text"
              placeholder={placeholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
          {listContent}
        </div>

        {multiSelect && (
          <div className="flex items-center justify-end px-4 py-2.5 border-t border-gray-200 dark:border-border gap-2">
            <Button variant="outline" size="default" onClick={() => onOpenChange(false)}>
              {t('sweep.entities.cancel')}
            </Button>
            <Button
              size="default"
              onClick={handleMultiConfirm}
              disabled={selectedIds.size === 0 || isConfirming}
            >
              {isConfirming && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {resolvedConfirmLabel}
            </Button>
          </div>
        )}
      </DialogContent>
      <QuickAddPersonDialog
        open={createQuery !== null}
        onOpenChange={(next) => {
          if (!next) setCreateQuery(null);
        }}
        initialName={createQuery ?? ''}
        onCreated={handlePersonCreated}
      />
    </Dialog>
  );
}
