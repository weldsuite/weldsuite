import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useMemberNote, useUpsertMemberNote } from '@/hooks/queries/use-team-queries';
import { toast } from 'sonner';

interface NotesTabProps {
  userId: string;
  embedded?: boolean;
}

export function NotesTab({ userId, embedded = false }: NotesTabProps) {
  const t = useTranslations();
  const noteQuery = useMemberNote(userId);
  const upsert = useUpsertMemberNote(userId);

  const [draft, setDraft] = React.useState<string>('');
  const [initialized, setInitialized] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const draftRef = React.useRef('');

  const autoResize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  React.useLayoutEffect(() => {
    autoResize();
  }, [draft, autoResize]);

  // Reset when switching to a different member
  React.useEffect(() => {
    setDraft('');
    draftRef.current = '';
    setInitialized(false);
  }, [userId]);

  const loaded = !noteQuery.isLoading;
  const serverBody = noteQuery.data?.body ?? '';

  // Seed the draft from the server only on the first successful load per userId.
  // After that, the user's keystrokes are the source of truth — never overwrite
  // them with refetched server data (would race with the user's typing).
  React.useEffect(() => {
    if (!initialized && loaded) {
      setDraft(serverBody);
      draftRef.current = serverBody;
      setInitialized(true);
    }
  }, [initialized, loaded, serverBody]);

  const save = React.useCallback(async (body: string) => {
    try {
      await upsert.mutateAsync({ body });
    } catch {
      toast.error(t('sweep.shared.failedToSaveNote'));
    }
  }, [upsert, t]);

  const onChange = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(value), 600);
  };

  // Flush any pending save on unmount so we don't lose the last keystrokes.
  React.useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      const pending = draftRef.current;
      if (pending) {
        // fire-and-forget: component is unmounting, no toast needed
        upsert.mutate({ body: pending });
      }
    }
  }, [upsert]);

  if (embedded) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('sweep.shared.yourPrivateNotes')}</h3>
        <div className="group flex flex-col gap-1">
          <Textarea
            ref={textareaRef}
            value={draft}
            disabled={!loaded}
            maxLength={1500}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('sweep.shared.addANotePlaceholder')}
            className="min-h-[160px] resize-none overflow-hidden border-transparent bg-transparent shadow-none p-0 focus-visible:ring-0 focus-visible:border-transparent"
          />
          <div className="text-right text-xs text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            {draft.length} / 1500
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1 p-4 pt-[22px]">
      <div>
        <h3 className="text-sm font-medium">{t('sweep.shared.yourPrivateNotes')}</h3>
      </div>

      <div className="group flex flex-col gap-1 flex-1">
        <Textarea
          ref={textareaRef}
          value={draft}
          disabled={!loaded}
          maxLength={1500}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('sweep.shared.notesTextareaPlaceholder')}
          className="min-h-[220px] resize-none overflow-hidden border-transparent bg-transparent shadow-none w-[calc(100%+24px)] -ml-3 hover:border-border focus-visible:border-border transition-colors"
        />
        <div className="text-right text-xs text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          {draft.length} / 1500
        </div>
      </div>
    </div>
  );
}
