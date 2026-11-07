import { useState } from 'react';
import { ExternalLink, Loader2, Pencil, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeReleaseDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { useGenerateMergeReleaseNotes, useUpdateMergeRelease } from '@/hooks/queries/use-weldmerge-across-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { MarkdownBody } from '../../components/primitives';
import { fill, relativeTime } from '../../lib/format';

/**
 * The notes of a release: rendered Markdown, an editor for a draft, and AI
 * generation (which spends credits and replaces what is written).
 */
export function ReleaseNotesCard({ release, canEdit }: Readonly<{ release: MergeReleaseDetailDto; canEdit: boolean }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const td = tm.across.releases.detail;
  const update = useUpdateMergeRelease();
  const generate = useGenerateMergeReleaseNotes();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState('');

  const startEditing = () => {
    setNotes(release.notes ?? '');
    setEditing(true);
  };

  const doGenerate = () =>
    generate.mutate(release.id, {
      onSuccess: () => {
        setEditing(false);
        toast.success(td.generated);
      },
      onError: () => toast.error(td.generateFailed),
    });

  const save = () =>
    update.mutate(
      { id: release.id, input: { notes: notes.trim() === '' ? null : notes } },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success(td.notesSaved);
        },
        onError: () => toast.error(td.saveFailed),
      },
    );

  const actions =
    canEdit && !editing ? (
      <span className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={startEditing}>
          <Pencil />
          {td.notesEdit}
        </Button>
        <Button variant="ghost" size="sm" onClick={doGenerate} disabled={generate.isPending}>
          {generate.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {generate.isPending ? td.generating : td.generateNotes}
        </Button>
      </span>
    ) : undefined;

  return (
    <SectionCard title={td.notes} action={actions}>
      {editing ? (
        <div className="space-y-2">
          <Textarea
            autoFocus
            rows={14}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={td.notesPlaceholder}
            aria-label={td.notes}
            className="font-mono text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={update.isPending}>
              {update.isPending && <Loader2 className="animate-spin" />}
              {td.notesSave}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              {t.common.actions.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {release.notes ? <MarkdownBody>{release.notes}</MarkdownBody> : <p className="text-sm text-muted-foreground">{td.noNotes}</p>}
          {release.notesGeneratedAt && (
            <p className="text-xs text-muted-foreground">
              {fill(td.notesGeneratedAt, { time: relativeTime(release.notesGeneratedAt, language, tm.justNow) })}
            </p>
          )}
          {canEdit && <p className="text-xs text-muted-foreground">{td.generateCost}</p>}
          {release.status === 'shipped' && <p className="text-xs text-muted-foreground">{td.shippedNoEdit}</p>}
          {release.knowledgePageId && (
            <Link href={`/weldknow/page/${release.knowledgePageId}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ExternalLink className="size-3" />
              {tm.across.releases.publish.knowledgePage}
            </Link>
          )}
        </div>
      )}
    </SectionCard>
  );
}
