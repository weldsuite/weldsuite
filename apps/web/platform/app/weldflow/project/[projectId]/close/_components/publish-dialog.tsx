import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { PublishLessonsResult } from '@weldsuite/app-api-client/domains/project-closing';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useKnowledgeSpaces } from '@/hooks/queries/use-knowledge-queries';
import { usePublishLessons } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '../_lib/api-error';
import { useClose } from './close-context';

type WritableSpace = NonNullable<ReturnType<typeof useKnowledgeSpaces>['data']>['data'][number];

function SpaceField({
  isError,
  isLoading,
  writable,
  spaceId,
  onChange,
  invalid,
}: Readonly<{ isError: boolean; isLoading: boolean; writable: WritableSpace[]; spaceId: string; onChange: (id: string) => void; invalid: boolean }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.publish;
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {copy.spacesFailed}
      </p>
    );
  }
  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {copy.loadingSpaces}
      </p>
    );
  }
  if (writable.length === 0) return <p className="text-sm text-muted-foreground">{copy.noSpaces}</p>;
  return (
    <Select value={spaceId} onValueChange={onChange}>
      <SelectTrigger id="publish-space" aria-invalid={invalid}>
        <SelectValue placeholder={copy.spacePlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {writable.map((space) => (
          <SelectItem key={space.id} value={space.id}>
            {space.kind === 'personal' ? format(copy.personalSuffix, { name: space.name }) : space.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Publish every lesson as one WeldKnow page in a teamspace the person can write in. */
export function PublishDialog({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const { t, language, plural, format } = useI18n();
  const copy = t.flowClosing.close.publish;
  const { projectId } = useClose();
  const spaces = useKnowledgeSpaces(open);
  const publish = usePublishLessons();
  const [spaceId, setSpaceId] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<PublishLessonsResult | null>(null);

  const writable = (spaces.data?.data ?? []).filter((space) => space.canWrite);
  const spaceName = (id: string) => writable.find((space) => space.id === id)?.name ?? '';

  const close = () => {
    setResult(null);
    setTouched(false);
    setSpaceId('');
    onClose();
  };

  const submit = async () => {
    if (!spaceId) {
      setTouched(true);
      return;
    }
    try {
      const res = await publish.mutateAsync({ projectId, spaceId, locale: language === 'nl' ? 'nl' : 'en' });
      setResult(res.data);
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.successTitle}</DialogTitle>
              <DialogDescription>
                {format(plural(result.lessonCount, copy.successDescription), { space: spaceName(result.spaceId) })}
              </DialogDescription>
            </DialogHeader>
            <Link href={`/weldknow/page/${result.pageId}`} className="text-sm font-medium text-primary hover:underline">
              {copy.openPage}
            </Link>
            <DialogFooter>
              <Button type="button" onClick={close}>
                {copy.done}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="publish-space">{copy.space}</Label>
              <SpaceField
                isError={spaces.isError}
                isLoading={spaces.isLoading}
                writable={writable}
                spaceId={spaceId}
                onChange={setSpaceId}
                invalid={touched && !spaceId}
              />
              {touched && !spaceId ? (
                <p role="alert" className="text-sm text-destructive">
                  {copy.spaceRequired}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={publish.isPending}>
                {t.flowClosing.shared.cancel}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={publish.isPending || writable.length === 0}>
                {publish.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {publish.isPending ? copy.submitting : copy.submit}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
