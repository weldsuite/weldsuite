
import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Star,
  Trash2,
  EllipsisVertical,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday, isThisWeek, isThisMonth, isThisYear } from 'date-fns';
import { useCreateCustomerNote, useUpdateCustomerNote, useDeleteCustomerNote } from '@/hooks/queries/use-customer-notes-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import type { Member } from '@weldsuite/core-api-client/schemas/members';
import { useUser } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import type { NotesSectionProps, Activity } from '../types';
import { useCustomerDetailContext } from '../customer-detail-provider';
import { NoteEditorDialog, getNoteTitle, type Note } from '../note-editor-dialog';
import { useTranslations } from '@weldsuite/i18n/client';

// Helper to format date for display
function formatNoteDate(date: Date, t: (key: string) => string): string {
  if (isToday(date)) return t('sweep.weldcrm.notesView.today');
  if (isYesterday(date)) return t('sweep.weldcrm.notesView.yesterday');
  return format(date, 'MMM d, yyyy');
}

// Convert Activity to Note
function activityToNote(
  activity: Activity,
  customerName?: string,
  memberById?: Map<string, { name?: string; picture?: string }>,
  currentUser?: { id?: string; name?: string; picture?: string },
): Note {
  let member = activity.assignedToId ? memberById?.get(activity.assignedToId) : undefined;
  // Fallback: if the assignee is the logged-in user but we couldn't resolve them in
  // the members list (e.g. not yet loaded), use the Clerk identity directly.
  if ((!member || !member.name) && currentUser?.id && activity.assignedToId === currentUser.id) {
    member = { name: currentUser.name, picture: currentUser.picture };
  }
  return {
    id: activity.id,
    content: activity.description || activity.subject || '',
    createdAt: new Date(activity.createdAt),
    updatedAt: new Date(activity.updatedAt),
    isPinned: false,
    customerId: activity.customerId,
    customerName,
    authorName: member?.name,
    authorAvatar: member?.picture,
  } as Note;
}

export function NotesSection({ customer, activities }: NotesSectionProps) {
  const t = useTranslations();
  const { silentRefresh, mode, isExpanded, entityType } = useCustomerDetailContext();
  const createNoteMutation = useCreateCustomerNote();
  const updateNoteMutation = useUpdateCustomerNote();
  const deleteNoteMutation = useDeleteCustomerNote();
  const { data: membersData } = useWorkspaceMembers(1, 100);
  const { user } = useUser();
  // The compact panel (~500px) gets a stripped-down layout; expanded panel
  // mirrors the page route's full-width layout.
  const isPanel = (mode === 'panel' && !isExpanded) || mode === 'embedded';
  const customerName = customer.fullName || customer.companyName || customer.tradingName || customer.email || '';

  const memberById = useMemo(() => {
    const map = new Map<string, { name?: string; picture?: string }>();
    ((membersData?.data || []) as Member[]).forEach((m) => {
      if (m.userId) map.set(m.userId, { name: m.name ?? undefined, picture: m.picture ?? undefined });
      if (m.id) map.set(m.id, { name: m.name ?? undefined, picture: m.picture ?? undefined });
    });
    return map;
  }, [membersData]);

  // Convert activities to notes
  const [notes, setNotes] = useState<Note[]>(() =>
    activities.map(a => activityToNote(a, customerName, memberById, {
      id: user?.id,
      name: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress,
      picture: user?.imageUrl,
    }))
  );
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // Sync notes when activities prop changes
  useEffect(() => {
    setNotes(activities.map(a => activityToNote(a, customerName, memberById, {
      id: user?.id,
      name: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress,
      picture: user?.imageUrl,
    })));
  }, [activities, customerName, memberById, user?.id, user?.fullName, user?.firstName, user?.primaryEmailAddress?.emailAddress, user?.imageUrl]);

  // Memoize available authors for filters
  const availableAuthors = useMemo(() =>
    Array.from(new Set(notes.map(n => n.authorName).filter(Boolean))) as string[],
    [notes]
  );

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'date',
      label: t('sweep.weldcrm.notesView.created'),
      options: [
        { value: 'today', label: t('sweep.weldcrm.notesView.today') },
        { value: 'yesterday', label: t('sweep.weldcrm.notesView.yesterday') },
        { value: 'this-week', label: t('sweep.weldcrm.notesSection.thisWeek') },
        { value: 'this-month', label: t('sweep.weldcrm.notesSection.thisMonth') },
        { value: 'this-year', label: t('sweep.weldcrm.notesSection.thisYear') },
        { value: 'older', label: t('sweep.weldcrm.notesView.older') },
      ],
    },
    {
      field: 'favorite',
      label: t('sweep.weldcrm.notesSection.favorite'),
      options: [
        { value: 'true', label: t('sweep.weldcrm.notesSection.favorited') },
        { value: 'false', label: t('sweep.weldcrm.notesSection.notFavorited') },
      ],
    },
    ...(availableAuthors.length > 0 ? [{
      field: 'author',
      label: t('sweep.weldcrm.notesView.author'),
      options: availableAuthors.map(name => ({ value: name, label: name })),
    }] : []),
  ], [availableAuthors, t]);

  // Group configurations by time
  const groupConfigs: GroupConfig<Note>[] = useMemo(() => [
    {
      id: 'today',
      label: t('sweep.weldcrm.notesView.createdToday'),
      sortOrder: 1,
      filter: (n) => isToday(new Date(n.createdAt)),
    },
    {
      id: 'yesterday',
      label: t('sweep.weldcrm.notesView.createdYesterday'),
      sortOrder: 2,
      filter: (n) => isYesterday(new Date(n.createdAt)),
    },
    {
      id: 'this-week',
      label: t('sweep.weldcrm.notesView.createdThisWeek'),
      sortOrder: 3,
      filter: (n) => {
        const d = new Date(n.createdAt);
        return isThisWeek(d, { weekStartsOn: 1 }) && !isToday(d) && !isYesterday(d);
      },
    },
    {
      id: 'this-month',
      label: t('sweep.weldcrm.notesView.createdThisMonth'),
      sortOrder: 4,
      filter: (n) => {
        const d = new Date(n.createdAt);
        return isThisMonth(d) && !isThisWeek(d, { weekStartsOn: 1 });
      },
    },
    {
      id: 'this-year',
      label: t('sweep.weldcrm.notesView.createdThisYear'),
      sortOrder: 5,
      filter: (n) => {
        const d = new Date(n.createdAt);
        return isThisYear(d) && !isThisMonth(d);
      },
    },
    {
      id: 'older',
      label: t('sweep.weldcrm.notesView.older'),
      sortOrder: 6,
      filter: (n) => !isThisYear(new Date(n.createdAt)),
    },
  ], [t]);

  // Apply filters
  const applyFilters = useCallback((items: Note[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'author') {
        result = filter.operator === 'is'
          ? result.filter(n => n.authorName === filter.value)
          : result.filter(n => n.authorName !== filter.value);
      } else if (filter.field === 'favorite') {
        const wantFavorite = filter.value === 'true';
        result = filter.operator === 'is'
          ? result.filter(n => !!n.isPinned === wantFavorite)
          : result.filter(n => !!n.isPinned !== wantFavorite);
      } else if (filter.field === 'date') {
        const matchesRange = (n: Note) => {
          const d = new Date(n.createdAt);
          switch (filter.value) {
            case 'today': return isToday(d);
            case 'yesterday': return isYesterday(d);
            case 'this-week': return isThisWeek(d, { weekStartsOn: 1 }) && !isToday(d) && !isYesterday(d);
            case 'this-month': return isThisMonth(d) && !isThisWeek(d, { weekStartsOn: 1 });
            case 'this-year': return isThisYear(d) && !isThisMonth(d);
            case 'older': return !isThisYear(d);
            default: return true;
          }
        };
        result = filter.operator === 'is' ? result.filter(matchesRange) : result.filter(n => !matchesRange(n));
      }
    });
    return result;
  }, []);

  // Handlers
  const openEditDialog = useCallback((note: Note) => {
    setSelectedNote(note);
    setShowEditor(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setShowEditor(open);
    if (!open) setSelectedNote(null);
  }, []);

  const handleSave = async (noteId: string, content: string) => {
    // Optimistic update — title in the list updates immediately
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, content, updatedAt: new Date() } : n))
    );
    await updateNoteMutation.mutateAsync({ noteId, customerId: customer.id, content });
  };

  const handleCreate = async () => {
    try {
      const result = await createNoteMutation.mutateAsync({ customerId: customer.id, content: '', entityType });
      const currentAuthorName =
        user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || undefined;
      const newNote: Note = {
        id: result.id,
        content: '',
        createdAt: new Date(),
        updatedAt: new Date(),
        isPinned: false,
        customerId: customer.id,
        customerName,
        authorName: currentAuthorName,
        authorAvatar: user?.imageUrl || undefined,
      } as Note;
      setNotes([newNote, ...notes]);
      setSelectedNote(newNote);
      setShowEditor(true);
      silentRefresh();
    } catch (error) {
      console.error('Failed to create note:', error);
      toast.error(t('sweep.weldcrm.notesView.failedToCreateNote'));
    }
  };

  const handleDelete = useCallback(async (noteId: string) => {
    try {
      await deleteNoteMutation.mutateAsync({ noteId, customerId: customer.id });
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setShowEditor(false);
      setSelectedNote(null);
      toast.success(t('sweep.weldcrm.notesView.noteDeleted'));
      silentRefresh();
    } catch {
      toast.error(t('sweep.weldcrm.notesView.failedToDeleteNote'));
    }
  }, [deleteNoteMutation, customer.id, t, silentRefresh]);

  const handleToggleFavorite = async (noteId: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, isPinned: !n.isPinned } : n))
    );
  };

  // Row renderer
  const renderNoteRow = useCallback((note: Note) => (
    <div key={note.id}>
      {/* Desktop row - hidden in panel mode */}
      {!isPanel && <div
        onClick={() => openEditDialog(note)}
        className="hidden md:flex items-center gap-4 px-4 py-3 border-b border-border/70 group cursor-pointer hover:bg-muted/50"
      >
        {/* Favorite */}
        <div className="w-[28px] flex items-center -mr-4" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            onClick={() => handleToggleFavorite(note.id)}
            className="p-1 rounded-md hover:bg-muted h-auto w-auto"
          >
            <Star className={cn("h-3.5 w-3.5", note.isPinned ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/50 hover:text-muted-foreground")} />
          </Button>
        </div>

        {/* Note Title */}
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <span className="text-sm font-medium text-foreground truncate">
            {getNoteTitle(note.content) === 'Untitled' ? t('sweep.weldcrm.globalPinnedNote.untitled') : getNoteTitle(note.content)}
          </span>
        </div>

        {/* Date */}
        <div className="w-[140px]">
          <span className="text-sm text-muted-foreground">
            {formatNoteDate(new Date(note.createdAt), t)}
          </span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openEditDialog(note); }}>
                <Pencil className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.notesView.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleToggleFavorite(note.id); }}>
                <Star className={cn("mr-0.5 h-4 w-4", note.isPinned && "fill-yellow-400 text-yellow-400")} />
                {note.isPinned ? t('sweep.weldcrm.notesView.unfavorite') : t('sweep.weldcrm.notesView.favorite')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                {t('sweep.weldcrm.notesView.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>}

      {/* Compact row - always in panel mode, mobile-only otherwise */}
      <div
        className={cn(
          isPanel ? "flex" : "md:hidden flex",
          "group items-center gap-3 px-3 py-3 border-b border-border/70 cursor-pointer hover:bg-muted/50"
        )}
        onClick={() => openEditDialog(note)}
      >
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            onClick={() => handleToggleFavorite(note.id)}
            className="p-1 rounded-md hover:bg-muted inline-flex items-center justify-center h-auto w-auto"
          >
            <Star className={cn("h-[15px] w-[15px]", note.isPinned ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/50 hover:text-muted-foreground")} />
          </Button>
        </div>
        <div className="flex-1 min-w-0 -ml-1.5">
          <span className="text-sm font-medium text-foreground truncate block">
            {getNoteTitle(note.content) === 'Untitled' ? t('sweep.weldcrm.globalPinnedNote.untitled') : getNoteTitle(note.content)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 w-[140px] flex-shrink-0">
          {note.authorName && (
            <>
              <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0" title={note.authorName}>
                {note.authorAvatar && (
                  <AvatarImage src={note.authorAvatar} alt={note.authorName} className="!rounded-[7px]" />
                )}
                <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                  {note.authorName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm text-muted-foreground truncate min-w-0">{note.authorName}</span>
            </>
          )}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEditDialog(note)}>
                <Pencil className="mr-0.5 h-4 w-4" />
                {t('sweep.weldcrm.notesView.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleToggleFavorite(note.id)}>
                <Star className={cn("mr-0.5 h-4 w-4", note.isPinned && "fill-yellow-400 text-yellow-400")} />
                {note.isPinned ? t('sweep.weldcrm.notesView.unfavorite') : t('sweep.weldcrm.notesView.favorite')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleDelete(note.id)}
                className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
              >
                <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                {t('sweep.weldcrm.notesView.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  ), [openEditDialog, isPanel, t, handleDelete]);

  // Header columns (no Company column since we're already on a customer page)
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'favorite', header: '', width: 'w-[28px] -mr-4' },
    { id: 'title', header: t('sweep.weldcrm.notesView.title'), width: 'flex-1 min-w-[200px] -ml-6' },
    { id: 'date', header: t('sweep.weldcrm.notesView.created'), width: 'w-[140px]' },
  ], [t]);

  // Sort notes: favorited first, then by date descending
  const sortedNotes = useMemo(() =>
    [...notes].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }),
    [notes]
  );

  return (
    <EntityList<Note>
      items={sortedNotes}
      isLoading={false}
      headerColumns={isPanel ? undefined : headerColumns}
      filters={filterConfigs}
      groups={
        isPanel
          ? [{
              id: 'all',
              label: t('sweep.weldcrm.notesSection.allNotes'),
              sortOrder: 1,
              filter: () => true,
              rightContent: (
                <>
                  <div className="w-[140px]">
                    <span className="text-xs font-medium text-muted-foreground">{t('sweep.weldcrm.notesSection.participant')}</span>
                  </div>
                  <div className="w-[35px]" aria-hidden />
                </>
              ),
            }]
          : groupConfigs
      }
      maxFilters={3}
      applyFilters={applyFilters}
      onDeleteItem={(id) => handleDelete(id)}
      renderRow={renderNoteRow}
      searchPlaceholder={t('sweep.weldcrm.notesView.searchPlaceholder')}
      searchFields={['content']}
      emptyStateClassName="pb-24"
      createButton={{
        label: t('sweep.weldcrm.notesView.newNote'),
        onClick: handleCreate,
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="-6 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Pencil */}
              <g transform="rotate(-45 60 60)">
                {/* Pencil body */}
                <rect x="50" y="20" width="12" height="64" rx="1" className="fill-white dark:fill-white/[0.03]" />
                <rect x="50" y="20" width="12" height="64" rx="1" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Pencil stripe */}
                <rect x="50" y="20" width="12" height="8" rx="1" className="fill-gray-100 dark:fill-white/8" />
                <rect x="50" y="20" width="12" height="8" rx="1" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Pencil tip */}
                <path d="M50 84L56 96L62 84" className="fill-gray-50 dark:fill-white/[0.06]" />
                <path d="M50 84L56 96L62 84" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Tip point */}
                <path d="M54 90L56 96L58 90" className="fill-gray-300 dark:fill-white/20" />
              </g>
              {/* Writing line scribble */}
              <path d="M30 94C36 90 42 94 48 90C54 86 60 90 66 86" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: t('sweep.weldcrm.notesView.noNotesYet'),
        description: t('sweep.weldcrm.notesView.noNotesYetDescription'),
        action: {
          label: t('sweep.weldcrm.notesView.newNote'),
          onClick: handleCreate,
        },
      }}
      noResultsState={{
        title: t('sweep.weldcrm.notesView.noNotesFound'),
        description: t('sweep.weldcrm.notesView.noNotesFoundDescription'),
      }}
      dialogComponent={
        <NoteEditorDialog
          note={selectedNote}
          open={showEditor}
          onOpenChange={handleDialogClose}
          onSave={async (content) => {
            if (selectedNote) {
              await handleSave(selectedNote.id, content);
              setNotes((prev) =>
                prev.map((n) =>
                  n.id === selectedNote.id ? { ...n, content, updatedAt: new Date() } : n
                )
              );
            }
          }}
          onDelete={() => {
            if (selectedNote) {
              handleDelete(selectedNote.id);
            }
          }}
        />
      }
    />
  );
}
