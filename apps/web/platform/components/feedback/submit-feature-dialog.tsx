
import * as React from 'react';
import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Lightbulb, Bug, Zap, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { FeatureType } from '@/lib/db/schema/feature-requests';
import { useMutation } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface SubmitFeatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function SubmitFeatureDialog({
  open,
  onOpenChange,
  onSuccess,
}: SubmitFeatureDialogProps) {
  const t = useTranslations();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<FeatureType>('feature');
  const { getClient } = useAppApiClient();

  const submitMutation = useMutation({
    mutationFn: async (data: { title: string; description: string; type: FeatureType }) => {
      const client = await getClient();
      return client.post<{ data?: { id: string } }>('/feature-requests', data);
    },
  });

  const isPending = submitMutation.isPending;

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setType('feature');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error(t('sweep.shared.pleaseEnterATitle'));
      return;
    }

    if (!description.trim()) {
      toast.error(t('sweep.shared.pleaseEnterADescription'));
      return;
    }

    try {
      const result = await submitMutation.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        type,
      });

      if (result.data) {
        toast.success(t('sweep.shared.feedbackSubmittedThankYou'));
        resetForm();
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(t('sweep.shared.failedToSubmitFeedback'));
      }
    } catch {
      toast.error(t('sweep.shared.failedToSubmitFeedback'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('sweep.shared.submitFeedback')}</DialogTitle>
            <DialogDescription>
              {t('sweep.shared.submitFeedbackDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Type Selection */}
            <div className="space-y-2">
              <Label>{t('sweep.shared.type')}</Label>
              <RadioGroup
                value={type}
                onValueChange={(value) => setType(value as FeatureType)}
                className="grid grid-cols-3 gap-3"
              >
                <label
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-3 cursor-pointer transition-colors',
                    type === 'feature'
                      ? 'border-amber-500 bg-amber-500/10'
                      : 'hover:bg-accent'
                  )}
                >
                  <RadioGroupItem value="feature" className="sr-only" />
                  <Lightbulb
                    className={cn(
                      'h-5 w-5',
                      type === 'feature' ? 'text-amber-500' : 'text-muted-foreground'
                    )}
                  />
                  <span className={cn('text-sm font-medium', type === 'feature' && 'text-amber-600')}>
                    {t('sweep.shared.featureType.feature')}
                  </span>
                </label>

                <label
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-3 cursor-pointer transition-colors',
                    type === 'bug'
                      ? 'border-red-500 bg-red-500/10'
                      : 'hover:bg-accent'
                  )}
                >
                  <RadioGroupItem value="bug" className="sr-only" />
                  <Bug
                    className={cn(
                      'h-5 w-5',
                      type === 'bug' ? 'text-red-500' : 'text-muted-foreground'
                    )}
                  />
                  <span className={cn('text-sm font-medium', type === 'bug' && 'text-red-600')}>
                    {t('sweep.shared.featureType.bug')}
                  </span>
                </label>

                <label
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-3 cursor-pointer transition-colors',
                    type === 'improvement'
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'hover:bg-accent'
                  )}
                >
                  <RadioGroupItem value="improvement" className="sr-only" />
                  <Zap
                    className={cn(
                      'h-5 w-5',
                      type === 'improvement' ? 'text-blue-500' : 'text-muted-foreground'
                    )}
                  />
                  <span className={cn('text-sm font-medium', type === 'improvement' && 'text-blue-600')}>
                    {t('sweep.shared.featureType.improvement')}
                  </span>
                </label>
              </RadioGroup>
            </div>

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="title">{t('sweep.shared.title')}</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  type === 'bug'
                    ? t('sweep.shared.describeBugBrieflyPlaceholder')
                    : type === 'improvement'
                    ? t('sweep.shared.whatWouldYouImprovePlaceholder')
                    : t('sweep.shared.whatFeatureWouldYouLikePlaceholder')
                }
                maxLength={500}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">{t('sweep.shared.description')}</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  type === 'bug'
                    ? t('sweep.shared.stepsToReproducePlaceholder')
                    : t('sweep.shared.describeYourIdeaPlaceholder')
                }
                rows={4}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t('sweep.shared.cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('sweep.shared.submittingEllipsis')}
                </>
              ) : (
                t('sweep.shared.submit')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
