
import { useState, useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { VisuallyHidden } from '@weldsuite/ui/components/visually-hidden';
import { usePinnedNotes } from '@/contexts/pinned-notes-context';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
// Temporarily disabled: import '@/styles/pinned-note.css';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { 
  MoreHorizontal,
  Link2,
  Copy,
  Star,
  Trash2,
  X,
  Building2,
  Pin
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface NoteEditorModalProps {
  note: {
    id: string;
    title: string;
    content: string;
    createdAt: Date;
    updatedAt: Date;
    isFavorite?: boolean;
    linkedCompany?: {
      id: string;
      name: string;
      logoUrl?: string;
      color?: string;
    };
    author?: {
      id: string;
      name: string;
      avatarUrl?: string;
    };
  } | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (noteId: string, title: string, content: string) => void;
  onToggleFavorite: (noteId: string) => void;
}

export function NoteEditorModal({ 
  note, 
  isOpen, 
  onClose, 
  onSave,
  onToggleFavorite 
}: NoteEditorModalProps) {
  const st = useTranslations();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const { addPinnedNote } = usePinnedNotes();
  const router = useRouter();

  useEffect(() => {
    if (note) {
      setTitle(note.title);
      setContent(note.content);
    }
  }, [note]);

  const handleSave = () => {
    if (note) {
      onSave(note.id, title, content);
    }
  };

  const getInitials = (name: string) => {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  };

  if (!note) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="h-[85vh] flex flex-col p-0 border-none overflow-hidden"
        showCloseButton={false}
        style={{
          maxWidth: '1200px',
          width: '90vw'
        }}>
        <VisuallyHidden>
          <DialogTitle>{st('sweep.weldflow.noteEditorModal.title')}</DialogTitle>
        </VisuallyHidden>
        {/* Header */}
        <div>
          <div className="flex items-center justify-between px-6 pt-3.5 pb-2.5 border-b border-gray-200 dark:border-border">
            <div className="flex items-center gap-3">
              {note.linkedCompany && (
                <Button
                  variant="ghost"
                  onClick={() => router.push(`/weldflow/companies/${note.linkedCompany?.id}`)}
                  className="flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-secondary px-2 py-1 -ml-2 rounded-md transition-colors"
                >
                  <Avatar className="h-[22px] w-[22px] rounded">
                    <AvatarImage src={note.linkedCompany.logoUrl} />
                    <AvatarFallback
                      className="rounded text-[7.5px] font-medium text-white"
                      style={{
                        backgroundColor: note.linkedCompany.color || '#6B7280'
                      }}
                    >
                      {getInitials(note.linkedCompany.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium text-base border-b border-gray-300 dark:border-gray-600">
                    {note.linkedCompany.name}
                  </span>
                </Button>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onToggleFavorite(note.id)}
              >
                <Star 
                  className={cn(
                    "h-4 w-4",
                    note.isFavorite 
                      ? "fill-yellow-400 text-yellow-400" 
                      : "text-gray-400"
                  )} 
                />
              </Button>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title={st('sweep.weldflow.noteEditorModal.pinToScreen')}
                onClick={() => {
                  if (note) {
                    // Save current state before pinning
                    onSave(note.id, title, content);
                    // Add to pinned notes with updated content
                    addPinnedNote({
                      ...note,
                      title,
                      content
                    });
                    // Close the modal
                    onClose();
                  }
                }}
              >
                <Pin className="h-4 w-4 text-gray-400" />
              </Button>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4 text-gray-400" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigator.clipboard.writeText(`${window.location.origin}/projects/notes/${note.id}`)}>
                    <Copy className="h-3.5 w-3.5 mr-2" />
                    {st('sweep.weldflow.notesView.copyLink')}
                  </DropdownMenuItem>
                  <DropdownMenuItem>{st('sweep.weldflow.noteEditorModal.viewAllTemplates')}</DropdownMenuItem>
                  <DropdownMenuItem>{st('sweep.weldflow.noteEditorModal.createNewTemplate')}</DropdownMenuItem>
                  <DropdownMenuItem className="text-red-600">
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    {st('sweep.weldflow.noteEditorModal.deleteNote')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onClose}
              >
                <X className="h-4 w-4 text-gray-400" />
              </Button>
            </div>
          </div>
        </div>

        {/* Editor Content */}
        <div className="flex-1 overflow-hidden relative">
          <div className="h-full overflow-auto pinned-note-content">
            <div className="max-w-4xl mx-auto px-16 py-8">
            {/* Title */}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-4xl font-bold w-full border-none outline-none bg-transparent placeholder:text-gray-300 mb-8"
              placeholder={st('sweep.weldflow.notesView.untitled')}
            />

            {/* Content Editor */}
            <div className="space-y-4">
              {content === '' && (
                <div className="flex items-start gap-3 text-sm text-gray-400">
                  <span>{st('sweep.weldflow.noteEditorModal.startTypingOr')}</span>
                  <Button variant="link" className="text-blue-600 hover:underline">
                    {st('sweep.weldflow.noteEditorModal.createATemplate')}
                  </Button>
                </div>
              )}

              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full min-h-[400px] border-none outline-none bg-transparent resize-none text-base leading-relaxed placeholder:text-gray-400"
                placeholder={content === '' ? "" : st('sweep.weldflow.noteEditorModal.writeYourNotePlaceholder')}
                onBlur={handleSave}
              />
            </div>

            {/* Template Section */}
            {content === '' && (
              <div className="mt-8 space-y-6">
                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                    {st('sweep.weldflow.noteEditorModal.favoriteTemplates')}
                  </h3>
                  <p className="text-sm text-gray-400">
                    {st('sweep.weldflow.noteEditorModal.favoriteTemplatesDesc')}
                  </p>
                </div>

                <div>
                  <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                    {st('sweep.weldflow.noteEditorModal.actions')}
                  </h3>
                  <div className="space-y-2">
                    <Button variant="ghost" className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900">
                      <span className="text-gray-400">📄</span>
                      {st('sweep.weldflow.noteEditorModal.viewAllTemplates')}
                    </Button>
                    <Button variant="ghost" className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900">
                      <span className="text-gray-400">📄</span>
                      {st('sweep.weldflow.noteEditorModal.createNewTemplate')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-4">
            <span>{note.author?.name || st('sweep.weldflow.noteEditorModal.unknownAuthor')}</span>
            <span>•</span>
            <span>{format(note.updatedAt, 'MMM d, yyyy')}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}