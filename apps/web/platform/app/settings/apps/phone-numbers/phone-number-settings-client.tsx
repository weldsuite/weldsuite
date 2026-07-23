
import { useEffect, useMemo, useRef, useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { Search } from 'lucide-react';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Plus,
  Trash2,
  Settings,
  Star,
  Loader2,
  EllipsisVertical,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { toast } from 'sonner';
import type { VoipPhoneNumber } from '@/lib/api/domains/call-intelligence';
import {
  useUpdatePhoneNumber,
  useDeletePhoneNumber,
  useSetDefaultPhoneNumber,
} from '@/hooks/use-phone-numbers';
import { usePortingOrders, type PortingOrderStatus } from '@/hooks/use-porting';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

interface PhoneNumberSettingsClientProps {
  phoneNumbers: VoipPhoneNumber[];
  isConfigured: boolean;
}

function formatPhoneNumber(number: string): string {
  if (!number) return '';

  const cleaned = number.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+1') && cleaned.length === 12) {
    return `+1 (${cleaned.slice(2, 5)}) ${cleaned.slice(5, 8)}-${cleaned.slice(8)}`;
  }

  if (cleaned.startsWith('+44') && cleaned.length >= 12) {
    const national = cleaned.slice(3);
    if (national.startsWith('7')) {
      return `+44 ${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
    }
    return `+44 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
  }

  if (cleaned.startsWith('+31') && cleaned.length >= 11) {
    const national = cleaned.slice(3);
    if (national.startsWith('6')) {
      return `+31 6 ${national.slice(1, 5)} ${national.slice(5)}`;
    }
    return `+31 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
  }

  if (cleaned.startsWith('+49') && cleaned.length >= 12) {
    const national = cleaned.slice(3);
    if (national.startsWith('1')) {
      return `+49 ${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
    }
    return `+49 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
  }

  if (cleaned.startsWith('+33') && cleaned.length === 12) {
    const national = cleaned.slice(3);
    return `+33 ${national.slice(0, 1)} ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }

  if (cleaned.startsWith('+32') && cleaned.length >= 11) {
    const national = cleaned.slice(3);
    return `+32 ${national.slice(0, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7)}`;
  }

  if (cleaned.startsWith('+') && cleaned.length > 7) {
    const countryCode = cleaned.slice(0, cleaned.length > 12 ? 3 : 2);
    const rest = cleaned.slice(countryCode.length);
    const groups = rest.match(/.{1,4}/g) || [];
    return `${countryCode} ${groups.join(' ')}`;
  }

  return number;
}

export function PhoneNumberSettingsClient({
  phoneNumbers: initialPhoneNumbers,
  isConfigured,
}: PhoneNumberSettingsClientProps) {
  const router = useRouter();
  const ts = getTranslations('settings');
  const tp = ts.phoneNumbers;
  const [phoneNumbers, setPhoneNumbers] = useState(initialPhoneNumbers);
  const [selectedNumber, setSelectedNumber] = useState<VoipPhoneNumber | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');

  // Mutation hooks
  const updateMutation = useUpdatePhoneNumber();
  const deleteMutation = useDeletePhoneNumber();
  const setDefaultMutation = useSetDefaultPhoneNumber();

  const isSaving = updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  const handleSetDefault = async (numberId: string) => {
    setDefaultMutation.mutate(numberId, {
      onSuccess: () => {
        toast.success(tp.messages.defaultUpdated);
        setPhoneNumbers(prev =>
          prev.map(p => ({ ...p, isDefault: p.id === numberId }))
        );
      },
      onError: () => {
        toast.error(tp.messages.defaultFailed);
      },
    });
  };

  const handleEdit = (phoneNumber: VoipPhoneNumber) => {
    setSelectedNumber(phoneNumber);
    setEditDisplayName(phoneNumber.displayName || '');
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedNumber) return;
    updateMutation.mutate(
      { id: selectedNumber.id, data: { displayName: editDisplayName || null } },
      {
        onSuccess: () => {
          toast.success(tp.messages.updated);
          setPhoneNumbers(prev =>
            prev.map(p =>
              p.id === selectedNumber.id ? { ...p, displayName: editDisplayName } : p
            )
          );
          setIsEditDialogOpen(false);
        },
        onError: () => {
          toast.error(tp.messages.updateFailed);
        },
      },
    );
  };

  const handleDelete = async () => {
    if (!selectedNumber) return;
    deleteMutation.mutate(selectedNumber.id, {
      onSuccess: () => {
        toast.success(tp.messages.removed);
        setPhoneNumbers(prev => prev.filter(p => p.id !== selectedNumber.id));
        setIsDeleteDialogOpen(false);
      },
      onError: () => {
        toast.error(tp.messages.removeFailed);
      },
    });
  };

  const COUNTRIES = [
    { code: 'US', name: 'United States', prefix: '+1' },
    { code: 'CA', name: 'Canada', prefix: '+1' },
    { code: 'GB', name: 'United Kingdom', prefix: '+44' },
    { code: 'NL', name: 'Netherlands', prefix: '+31' },
    { code: 'DE', name: 'Germany', prefix: '+49' },
    { code: 'FR', name: 'France', prefix: '+33' },
    { code: 'BE', name: 'Belgium', prefix: '+32' },
    { code: 'AT', name: 'Austria', prefix: '+43' },
    { code: 'CH', name: 'Switzerland', prefix: '+41' },
    { code: 'AU', name: 'Australia', prefix: '+61' },
    { code: 'ES', name: 'Spain', prefix: '+34' },
    { code: 'IT', name: 'Italy', prefix: '+39' },
    { code: 'SE', name: 'Sweden', prefix: '+46' },
    { code: 'NO', name: 'Norway', prefix: '+47' },
    { code: 'DK', name: 'Denmark', prefix: '+45' },
    { code: 'PL', name: 'Poland', prefix: '+48' },
  ];

  const NUMBER_TYPES = [
    { value: 'local', label: 'Local' },
    { value: 'toll-free', label: 'Toll-Free' },
    { value: 'mobile', label: 'Mobile' },
  ];

  const columns: ColumnDef<VoipPhoneNumber>[] = [
    {
      accessorKey: 'phoneNumber',
      header: tp.columns.number,
      size: 250,
      cell: ({ row }) => {
        const phone = row.original;
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium">
              {phone.formattedNumber || formatPhoneNumber(phone.phoneNumber)}
            </span>
            {phone.isDefault && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{tp.defaultTooltip}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'displayName',
      header: tp.columns.name,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.displayName || '—'}
        </span>
      ),
    },
    {
      id: 'type',
      header: tp.columns.type,
      cell: ({ row }) => (
        <Badge variant="secondary" className="font-mono text-xs rounded-md border border-border capitalize">
          {row.original.numberType || 'local'}
        </Badge>
      ),
    },
    {
      accessorKey: 'countryCode',
      header: tp.columns.country,
      cell: ({ row }) => (
        <Badge variant="secondary" className="font-mono text-xs rounded-md border border-border">
          {row.original.countryCode}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const phone = row.original;

        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">{tp.openMenu}</span>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{tp.menu.actions}</DropdownMenuLabel>
                {!phone.isDefault && (
                  <DropdownMenuItem onClick={() => handleSetDefault(phone.id)}>
                    <Star className="h-4 w-4 mr-0.5" />
                    {tp.menu.setDefault}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => handleEdit(phone)}>
                  <Settings className="h-4 w-4 mr-0.5" />
                  {tp.menu.settings}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedNumber(phone);
                    setIsDeleteDialogOpen(true);
                  }}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                  {tp.menu.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const countries = Array.from(
      new Set(phoneNumbers.map((p) => p.countryCode).filter(Boolean) as string[]),
    ).sort();
    return [
      {
        field: 'type',
        label: tp.columns.type,
        filterType: 'select',
        options: NUMBER_TYPES.map((t) => ({ value: t.value, label: t.label })),
      },
      {
        field: 'country',
        label: tp.columns.country,
        filterType: 'select',
        searchable: true,
        options: countries.map((c) => ({
          value: c,
          label: COUNTRIES.find((co) => co.code === c)?.name ?? c,
        })),
      },
    ];
  }, [phoneNumbers]);

  const filteredPhoneNumbers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return phoneNumbers.filter((p) => {
      for (const f of activeFilters) {
        if (!f.value) continue;
        if (f.field === 'type' && (p.numberType ?? 'local') !== f.value) return false;
        if (f.field === 'country' && p.countryCode !== f.value) return false;
      }
      if (q) {
        const haystack = [
          p.phoneNumber,
          p.formattedNumber,
          p.displayName,
          p.countryCode,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [phoneNumbers, activeFilters, searchQuery]);

  const table = useReactTable({
    data: filteredPhoneNumbers,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tp.title}</h1>
        <p className="text-muted-foreground">{tp.description}</p>
      </div>

      <PendingPortsSection />

      <div className="space-y-3">
        {/* Filters */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />
          </div>

          <div className="flex items-center gap-2">
            <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={tp.searchPlaceholder} />
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={!isConfigured}
              onClick={() => router.push('/settings/apps/phone-numbers/port')}
            >
              {tp.portButton}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={!isConfigured}
              onClick={() => router.push('/settings/apps/phone-numbers/new-number')}
            >
              <Plus className="h-4 w-4 mr-0.5" />
              {tp.buyButton}
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="text-[13.5px]" style={{ width: header.getSize() }}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="h-[42px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    <p className="text-sm font-medium">{tp.noNumbers}</p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      {isConfigured
                        ? tp.noNumbersConfigured
                        : tp.noNumbersUnconfigured}
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tp.editDialog.title}</DialogTitle>
            <DialogDescription>
              {tp.editDialog.description}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{tp.editDialog.phoneNumberLabel}</Label>
              <Input
                value={
                  selectedNumber?.formattedNumber ||
                  formatPhoneNumber(selectedNumber?.phoneNumber || '')
                }
                disabled
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">{tp.editDialog.displayNameLabel}</Label>
              <Input
                id="displayName"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                placeholder={tp.editDialog.displayNamePlaceholder}
              />
              <p className="text-sm text-muted-foreground">
                {tp.editDialog.displayNameDescription}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {tp.editDialog.cancel}
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSaving}>
              {isSaving ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{tp.editDialog.saving}</>
              ) : (
                tp.editDialog.save
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tp.deleteDialog.title}</DialogTitle>
            <DialogDescription>
              {tp.deleteDialog.description}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="font-mono text-center text-lg">
              {selectedNumber?.formattedNumber ||
                formatPhoneNumber(selectedNumber?.phoneNumber || '')}
            </p>
            {selectedNumber?.displayName && (
              <p className="text-center text-muted-foreground">
                {selectedNumber.displayName}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              {tp.deleteDialog.cancel}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{tp.deleteDialog.removing}</>
              ) : (
                tp.deleteDialog.remove
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Pending ports section — shown above the main numbers list whenever the
// workspace has port-in orders that haven't reached 'completed' or 'cancelled'.
// ──────────────────────────────────────────────────────────────────────────────

const PENDING_STATUSES: PortingOrderStatus[] = [
  'draft',
  'awaiting_documents',
  'submitted',
  'in_process',
  'exception',
];

function PendingPortsSection() {
  const router = useRouter();
  const { data: orders } = usePortingOrders();
  const tp = getTranslations('settings').phoneNumbers;
  const pending = (orders ?? []).filter((o) => PENDING_STATUSES.includes(o.status));
  if (pending.length === 0) return null;

  return (
    <div className="mb-6 rounded-md border bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{tp.pendingPorts}</h3>
          <p className="text-xs text-muted-foreground">
            {tp.pendingPortsDescription}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {pending.map((order) => (
          <div
            key={order.id}
            className="flex items-center justify-between rounded border bg-background p-3"
          >
            <div className="flex items-center gap-3">
              <span className="font-medium">{order.formattedNumber ?? order.phoneNumber}</span>
              <Badge variant={order.status === 'exception' ? 'destructive' : 'outline'}>
                {order.status.replace('_', ' ')}
              </Badge>
              {order.substatus && (
                <span className="text-xs text-muted-foreground">{order.substatus}</span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/settings/apps/phone-numbers/port/${order.id}`)}
            >
              {tp.viewButton}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
