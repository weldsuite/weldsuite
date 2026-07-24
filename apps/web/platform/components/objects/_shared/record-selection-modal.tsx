/**
 * RecordSelectionModal — pick a company or a person.
 *
 * Lists both kinds in one searchable view backed by app-api
 * (`/api/companies` + `/api/people`). Selection returns a
 * discriminated record; callers branch on `kind`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Loader2, Search, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useAppApiClient } from '@/lib/api/use-app-api';

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

function getFaviconUrl(domain?: string | null): string | undefined {
  if (!domain) return undefined;
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean || !clean.includes('.')) return undefined;
  return `https://www.google.com/s2/favicons?domain=${clean}&sz=32`;
}

function mapCompany(c: ApiCompany, untitledLabel: string): SelectableRecord {
  const displayName = c.displayName || c.name || untitledLabel;
  const avatar =
    c.avatarUrl ||
    c.logoUrl ||
    getFaviconUrl(c.website || c.domain || (c.email?.includes('@') ? c.email.split('@')[1] : undefined));
  return { id: c.id, kind: 'company', displayName, email: c.email, avatarUrl: avatar };
}

function mapPerson(p: ApiPerson, untitledLabel: string): SelectableRecord {
  const displayName =
    p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || untitledLabel;
  return { id: p.id, kind: 'person', displayName, email: p.email, avatarUrl: p.avatarUrl };
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
}: RecordSelectionModalProps) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [records, setRecords] = useState<SelectableRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isConfirming, setIsConfirming] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const fetchRecords = async () => {
      setIsLoading(true);
      try {
        const client = await getClient();
        const searchParam = searchQuery.trim()
          ? `&search=${encodeURIComponent(searchQuery.trim())}`
          : '';
        const [companiesRes, peopleRes] = await Promise.all([
          kind === 'person'
            ? Promise.resolve({ data: [] as ApiCompany[] })
            : client.get<{ data?: ApiCompany[] }>(`/companies?limit=50${searchParam}`),
          kind === 'company'
            ? Promise.resolve({ data: [] as ApiPerson[] })
            : client.get<{ data?: ApiPerson[] }>(`/people?limit=50${searchParam}`),
        ]);
        if (controller.signal.aborted) return;
        const untitledCompanyLabel = t('sweep.entities.untitledCompany');
        const untitledPersonLabel = t('sweep.entities.untitledPerson');
        const next: SelectableRecord[] = [
          ...(companiesRes.data ?? []).map((c) => mapCompany(c, untitledCompanyLabel)),
          ...(peopleRes.data ?? []).map((p) => mapPerson(p, untitledPersonLabel)),
        ];
        setRecords(next);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Failed to fetch records:', err);
          setRecords([]);
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    const timeoutId = setTimeout(fetchRecords, 300);
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [searchQuery, open, getClient, kind, t]);

  useEffect(() => {
    if (!open) {
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
      if (!open) return;
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
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, selectedIndex, records, onSelectRecord, handleSingleSelect]);

  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      selected?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const title =
    kind === 'company'
      ? t('sweep.entities.chooseCompany')
      : kind === 'person'
        ? t('sweep.entities.choosePerson')
        : t('sweep.entities.chooseRecord');
  const placeholder =
    kind === 'company'
      ? t('sweep.entities.searchCompaniesPlaceholder')
      : kind === 'person'
        ? t('sweep.entities.searchPeoplePlaceholder')
        : t('sweep.entities.searchCompaniesAndPeoplePlaceholder');
  const resolvedConfirmLabel = confirmLabel ?? t('sweep.entities.addToList');

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
          {isLoading ? (
            <div className="flex items-center justify-center py-12 gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('sweep.entities.searchingEllipsis')}</p>
            </div>
          ) : records.length === 0 ? (
            <div className="h-full text-center flex flex-col items-center justify-center pb-12">
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? t('sweep.entities.noResultsFoundFor', { query: searchQuery })
                  : t('sweep.entities.noRecordsFound')}
              </p>
            </div>
          ) : (
            <div ref={listRef} className="flex flex-col gap-0.5">
              {records.map((record, index) => {
                const isAlready = existingIds.includes(record.id);
                const isChecked = selectedIds.has(record.id);
                return (
                <Button
                  key={`${record.kind}-${record.id}`}
                  variant="ghost"
                  disabled={isAlready}
                  className={cn(
                    'group w-full flex items-center gap-2.5 min-w-0 px-4 py-1.5 transition-colors text-left',
                    isAlready
                      ? 'opacity-50 cursor-not-allowed'
                      : multiSelect && isChecked
                        ? 'bg-primary/5 dark:bg-primary/10'
                        : keyboardActive && selectedIndex === index
                          ? 'bg-gray-100/70 dark:bg-secondary/60'
                          : 'hover:bg-gray-50 dark:hover:bg-secondary/40',
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
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <Avatar className="h-[22px] w-[22px] rounded-md border border-border flex-shrink-0">
                      <AvatarImage src={record.avatarUrl} />
                      <AvatarFallback className="rounded-md bg-muted text-[10px] font-medium">
                        {getInitial(record)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="font-medium text-[14px] text-foreground group-hover:text-primary truncate min-w-0">
                      {record.displayName}
                    </span>
                  </div>

                  {record.email && (
                    <span className="text-[12px] text-muted-foreground truncate flex-shrink-0 max-w-[40%]">
                      {record.email}
                    </span>
                  )}

                  {!kind && (
                    <span
                      className={cn(
                        'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none flex-shrink-0',
                        record.kind === 'person'
                          ? 'bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400'
                          : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400',
                      )}
                    >
                      {record.kind === 'person'
                        ? t('sweep.entities.personLabel')
                        : t('sweep.entities.companyLabel')}
                    </span>
                  )}
                </Button>
                );
              })}
            </div>
          )}
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
    </Dialog>
  );
}
