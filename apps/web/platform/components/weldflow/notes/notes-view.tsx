
import { useState } from 'react';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { NoteEditorModal } from './note-editor-modal';
import { usePinnedNotes } from '@/contexts/pinned-notes-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { 
  Plus, 
  MoreVertical,
  Grid3x3,
  List,
  Star,
  Archive,
  Trash2,
  Edit,
  Copy,
  ChevronDown,
  Columns,
  Settings,
  User,
  Search,
  Filter,
  Building2,
  StickyNote
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface LinkedCompany {
  id: string;
  name: string;
  logoUrl?: string;
  color?: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  isFavorite?: boolean;
  linkedCompany?: LinkedCompany;
  author?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
}

// Sample data matching Attio's design
const sampleNotes: Note[] = [
  {
    id: '1',
    title: 'wrgwrgwrtg',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    isFavorite: true,
    linkedCompany: {
      id: '1',
      name: 'LVMH',
      color: 'black'
    }
  },
  {
    id: '2',
    title: 'tgwrgwrtgwrtgwrtg',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '1',
      name: 'LVMH',
      color: 'black'
    }
  },
  {
    id: '3',
    title: 'iuytredfghjn',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '2',
      name: 'Airbnb',
      logoUrl: '/logos/airbnb.png',
      color: '#FF5A5F'
    }
  },
  {
    id: '4',
    title: 'gthjfvklc;de.rfgt',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '3',
      name: 'Disney',
      color: '#0063E0'
    }
  },
  {
    id: '5',
    title: 'yhgtrfv',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '4',
      name: 'Apple',
      logoUrl: '/logos/apple.png',
      color: 'black'
    }
  },
  {
    id: '6',
    title: 'wrgwrgwrtg',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '1',
      name: 'LVMH',
      color: 'black'
    }
  },
  {
    id: '7',
    title: 'tgwrgwrtgwrtgwrtg',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '1',
      name: 'LVMH',
      color: 'black'
    }
  },
  {
    id: '8',
    title: 'gwrtgwrgwrth',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '2',
      name: 'Airbnb',
      logoUrl: '/logos/airbnb.png',
      color: '#FF5A5F'
    }
  },
  {
    id: '9',
    title: 'iuytredfghjn',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '2',
      name: 'Airbnb',
      logoUrl: '/logos/airbnb.png',
      color: '#FF5A5F'
    }
  },
  {
    id: '10',
    title: 'gthjfvklc;de.rfgt',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-05'),
    updatedAt: new Date('2025-08-05'),
    linkedCompany: {
      id: '3',
      name: 'Disney',
      color: '#0063E0'
    }
  },
  {
    id: '11',
    title: 'Contact review',
    content: 'This note has no content.',
    createdAt: new Date('2025-08-04'),
    updatedAt: new Date('2025-08-04'),
    linkedCompany: {
      id: '5',
      name: 'United Airlines',
      color: '#002244'
    }
  }
];

export function NotesView() {
  const st = useTranslations();
  const [notes, setNotes] = useState<Note[]>(sampleNotes);
  const [sortBy, setSortBy] = useState<'creation' | 'updated'>('creation');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  // Toggle favorite status
  const toggleFavorite = (noteId: string) => {
    setNotes(notes.map(note => {
      if (note.id === noteId) {
        return { ...note, isFavorite: !note.isFavorite };
      }
      return note;
    }));
    // Update selected note if it's open
    if (selectedNote?.id === noteId) {
      setSelectedNote(prev => prev ? { ...prev, isFavorite: !prev.isFavorite } : null);
    }
  };

  // Open note editor
  const openNoteEditor = (note: Note) => {
    setSelectedNote(note);
    setIsEditorOpen(true);
  };

  // Save note changes
  const saveNote = (noteId: string, title: string, content: string) => {
    setNotes(notes.map(note => {
      if (note.id === noteId) {
        return { ...note, title, content, updatedAt: new Date() };
      }
      return note;
    }));
  };

  // Filter and group notes
  let filteredNotes = showFavoritesOnly 
    ? notes.filter(note => note.isFavorite)
    : notes;

  // Apply search filter
  if (searchTerm) {
    filteredNotes = filteredNotes.filter(note => 
      note.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      note.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
      note.linkedCompany?.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }

  // Group notes by date
  const groupedNotes: { [key: string]: Note[] } = {};
  const favoriteNotes = filteredNotes.filter(note => note.isFavorite);
  const nonFavoriteNotes = filteredNotes.filter(note => !note.isFavorite);

  nonFavoriteNotes.forEach(note => {
    const dateKey = format(note.createdAt, 'MMMM d, yyyy');
    if (!groupedNotes[dateKey]) {
      groupedNotes[dateKey] = [];
    }
    groupedNotes[dateKey].push(note);
  });

  // Get month count for recent notes
  const thisMonthCount = notes.filter(note => {
    const noteMonth = note.createdAt.getMonth();
    const currentMonth = new Date().getMonth();
    return noteMonth === currentMonth;
  }).length;

  const getInitials = (name: string) => {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  };

  const getCompanyColor = (company?: LinkedCompany) => {
    if (!company) return 'bg-gray-500';
    if (company.color) {
      if (company.color === 'black') return 'bg-gray-900';
      if (company.color.startsWith('#')) {
        return '';
      }
    }
    return 'bg-gray-500';
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{st('sweep.weldflow.notesView.title')}</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <Columns className="h-3.5 w-3.5" />
            </Button>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <Filter className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>{st('sweep.weldflow.notesView.filterBy')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}>
                <Star className={cn("h-3.5 w-3.5 mr-2", showFavoritesOnly && "fill-yellow-400 text-yellow-400")} />
                {st('sweep.weldflow.notesView.favoritesOnly')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <User className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.notesView.myNotes')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Building2 className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.notesView.byCompany')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{st('sweep.weldflow.notesView.dateRange')}</DropdownMenuLabel>
              <DropdownMenuItem>{st('sweep.weldflow.notesView.today')}</DropdownMenuItem>
              <DropdownMenuItem>{st('sweep.weldflow.notesView.thisWeek')}</DropdownMenuItem>
              <DropdownMenuItem>{st('sweep.weldflow.notesView.thisMonth')}</DropdownMenuItem>
              <DropdownMenuItem>{st('sweep.weldflow.notesView.allTime')}</DropdownMenuItem>
            </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <Input
              type="text"
              placeholder={st('sweep.weldflow.notesView.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 pl-8 pr-3 w-[200px]"
            />
          </div>

          <Button size="sm" className="h-8">
            <Plus className="h-3.5 w-3.5 mr-0.5" />
            {st('sweep.weldflow.notesView.newNote')}
          </Button>
          </div>
        </div>

        {/* Content */}
        <div className="mt-8">
          {/* Favorites Section */}
          {favoriteNotes.length > 0 && !showFavoritesOnly && (
            <div className="mb-14">
              <h2 className="text-sm font-medium text-gray-600 dark:text-muted-foreground mb-4 flex items-center gap-2">
                {st('sweep.weldflow.notesView.favorites')}
                <span className="bg-gray-100 dark:bg-secondary px-1.5 py-0.5 rounded-sm text-xs">
                  {favoriteNotes.length}
                </span>
              </h2>
              <div className="grid grid-cols-4 gap-4">
                {favoriteNotes.map(note => (
                  <NoteCard 
                    key={note.id} 
                    note={note} 
                    onToggleFavorite={toggleFavorite}
                    onClick={() => openNoteEditor(note)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Monthly Notes */}
          {!showFavoritesOnly && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-gray-600 dark:text-muted-foreground mb-4 flex items-center gap-2">
                {st('sweep.weldflow.notesView.allNotes')}
                <span className="bg-gray-100 dark:bg-secondary px-1.5 py-0.5 rounded-sm text-xs">
                  {thisMonthCount}
                </span>
              </h2>
              <div className="grid grid-cols-4 gap-4">
                {Object.entries(groupedNotes).map(([date, dateNotes]) => (
                  dateNotes.map(note => (
                    <NoteCard 
                      key={note.id} 
                      note={note} 
                      onToggleFavorite={toggleFavorite}
                      onClick={() => openNoteEditor(note)}
                    />
                  ))
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* Note Editor Modal */}
      <NoteEditorModal
        note={selectedNote}
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        onSave={saveNote}
        onToggleFavorite={toggleFavorite}
      />
    </div>
  );
}

// Note Card Component
function NoteCard({ note, onToggleFavorite, onClick }: { 
  note: Note; 
  onToggleFavorite: (id: string) => void;
  onClick: () => void;
}) {
  const st = useTranslations();
  const router = useRouter();

  const getInitials = (name: string) => {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  };

  const handleCompanyClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering the note card click
    if (note.linkedCompany?.id) {
      router.push(`/weldflow/companies/${note.linkedCompany.id}`);
    }
  };

  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(note.id);
  };

  return (
    <div 
      className="group relative bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}
    >
      {/* Star when favorited - Always visible in top-right corner */}
      {note.isFavorite && (
        <div className="absolute top-3 right-4 z-10 flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
              >
                <MoreVertical className="h-3 w-3 text-gray-400" />
              </Button>
            </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <Edit className="h-3.5 w-3.5 mr-2" />
                  {st('sweep.weldflow.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Copy className="h-3.5 w-3.5 mr-2" />
                  {st('sweep.weldflow.notesView.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigator.clipboard.writeText(`${window.location.origin}/projects/notes/${note.id}`)}>
                  <Copy className="h-3.5 w-3.5 mr-2" />
                  {st('sweep.weldflow.notesView.copyLink')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Archive className="h-3.5 w-3.5 mr-2" />
                  {st('sweep.weldflow.notesView.archive')}
                </DropdownMenuItem>
                <DropdownMenuItem className="text-red-600">
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  {st('sweep.weldflow.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          <Button
            variant="ghost"
            onClick={handleToggleFavorite}
            className="hover:scale-110 transition-all duration-200"
          >
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
          </Button>
        </div>
      )}
      
      {/* Star and Three dots on hover when not favorited */}
      {!note.isFavorite && (
        <div className="absolute top-3 right-4 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100">
          <Button
            variant="ghost"
            onClick={handleToggleFavorite}
            className="hover:scale-110 transition-all"
          >
            <Star className="h-4 w-4 text-gray-400 hover:text-yellow-400 hover:fill-yellow-400" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-6 w-6 transition-opacity"
              >
                <MoreVertical className="h-3 w-3 text-gray-400" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Edit className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.notesView.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(`${window.location.origin}/crm/notes/${note.id}`)}>
                <Copy className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.notesView.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Archive className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.notesView.archive')}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600">
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                {st('sweep.weldflow.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="p-4 min-h-[180px]">
        {/* Company Logo and Name */}
        <div className="mb-3">
          <Button
            variant="ghost"
            onClick={handleCompanyClick}
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <Avatar className="h-4 w-4 rounded">
              <AvatarImage src={note.linkedCompany?.logoUrl} />
              <AvatarFallback 
                className="rounded text-[6px] font-medium text-white"
                style={{
                  backgroundColor: note.linkedCompany?.color || '#6B7280'
                }}
              >
                {note.linkedCompany ? getInitials(note.linkedCompany.name) : '?'}
              </AvatarFallback>
            </Avatar>
            <span className="text-[13px] font-medium text-gray-900 dark:text-foreground underline">
              {note.linkedCompany?.name || st('sweep.weldflow.notesView.noCompany')}
            </span>
          </Button>
        </div>

        {/* Note Title */}
        <h3 className="font-medium text-gray-900 dark:text-foreground mb-1">
          {note.title}
        </h3>

        {/* Note Content */}
        <p className="text-sm text-gray-500 dark:text-muted-foreground line-clamp-3">
          {note.content}
        </p>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-100 dark:border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <User className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-xs text-gray-400">tetstet wedwdwde</span>
        </div>
        <span className="text-xs text-gray-400">
          {format(note.createdAt, 'MMMM d, yyyy')}
        </span>
      </div>
    </div>
  );
}