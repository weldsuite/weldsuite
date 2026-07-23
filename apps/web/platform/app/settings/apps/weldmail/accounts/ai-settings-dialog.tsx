import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Loader2 } from 'lucide-react';
import { useUpdateMailAccount } from '@/hooks/queries/use-mail-queries';
import { toast } from 'sonner';
import { AVAILABLE_MODELS } from '@/lib/weldagent/tools/types';
import { getTranslations } from '@/lib/i18n';

const NONE = 'none';

/**
 * Options for the model-preference picker.
 *
 * This used to fetch `GET /ai/models` from the legacy api-worker. That handler
 * did no work: it returned a hardcoded `FALLBACK_MODELS` constant that is
 * identical — same ids, names, tiers and prices — to `AVAILABLE_MODELS` here,
 * which the platform already ships and which `usage-dashboard.tsx` already
 * reads directly. So the request was a round-trip to fetch a constant the
 * client already had, and reading it locally is the same list with no fetch.
 *
 * Deliberately NOT repointed to app-api's `/api/ai-models/models`: that returns
 * 503 by design after the AI teardown, which would have silently emptied this
 * dropdown. If a real, server-owned model catalog returns, both this picker and
 * `AVAILABLE_MODELS` should move onto it together.
 */
const MODEL_OPTIONS = AVAILABLE_MODELS.map((m) => ({ id: m.id, name: m.name }));

const aiSettingsSchema = z.object({
  customInstructions: z.string().max(2000).optional(),
  defaultTone: z.enum(['professional', 'friendly', 'casual', NONE]).optional(),
  defaultLength: z.enum(['short', 'medium', 'long', NONE]).optional(),
  modelPreference: z.string().max(100).optional(),
});

type AiSettingsFormValues = z.infer<typeof aiSettingsSchema>;

interface AiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountEmail: string;
  defaultValues?: {
    customInstructions?: string;
    defaultTone?: 'professional' | 'friendly' | 'casual';
    defaultLength?: 'short' | 'medium' | 'long';
    modelPreference?: string;
  };
}

export function AiSettingsDialog({
  open,
  onOpenChange,
  accountId,
  accountEmail,
  defaultValues,
}: AiSettingsDialogProps) {
  const ts = getTranslations('settings');
  const tai = ts.weldmail.aiSettings;
  const updateAccount = useUpdateMailAccount();
  const models = MODEL_OPTIONS;

  const form = useForm<AiSettingsFormValues>({
    resolver: zodResolver(aiSettingsSchema),
    defaultValues: {
      customInstructions: defaultValues?.customInstructions || '',
      defaultTone: defaultValues?.defaultTone || NONE,
      defaultLength: defaultValues?.defaultLength || NONE,
      modelPreference: defaultValues?.modelPreference || NONE,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        customInstructions: defaultValues?.customInstructions || '',
        defaultTone: defaultValues?.defaultTone || '',
        defaultLength: defaultValues?.defaultLength || '',
        modelPreference: defaultValues?.modelPreference || '',
      });
    }
  }, [open, defaultValues]);

  const onSubmit = async (values: AiSettingsFormValues) => {
    try {
      await updateAccount.mutateAsync({
        id: accountId,
        aiSettings: {
          customInstructions: values.customInstructions || undefined,
          defaultTone: values.defaultTone && values.defaultTone !== NONE ? values.defaultTone as 'professional' | 'friendly' | 'casual' : undefined,
          defaultLength: values.defaultLength && values.defaultLength !== NONE ? values.defaultLength as 'short' | 'medium' | 'long' : undefined,
          modelPreference: values.modelPreference && values.modelPreference !== NONE ? values.modelPreference : undefined,
        },
      });
      toast.success(tai.messages.saved);
      onOpenChange(false);
    } catch {
      toast.error(tai.messages.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{tai.title}</DialogTitle>
          <DialogDescription>{accountEmail}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
            <FormField
              control={form.control}
              name="customInstructions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tai.customInstructions}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={tai.customInstructionsPlaceholder}
                      className="min-h-[100px] resize-y"
                      maxLength={2000}
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {(field.value || '').length}/2000
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultTone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tai.defaultTone}</FormLabel>
                  <Select value={field.value || NONE} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={tai.noDefault} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{tai.noDefault}</SelectItem>
                      <SelectItem value="professional">{tai.toneOptions.professional}</SelectItem>
                      <SelectItem value="friendly">{tai.toneOptions.friendly}</SelectItem>
                      <SelectItem value="casual">{tai.toneOptions.casual}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="defaultLength"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tai.defaultLength}</FormLabel>
                  <Select value={field.value || NONE} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={tai.noDefault} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{tai.noDefault}</SelectItem>
                      <SelectItem value="short">{tai.lengthOptions.short}</SelectItem>
                      <SelectItem value="medium">{tai.lengthOptions.medium}</SelectItem>
                      <SelectItem value="long">{tai.lengthOptions.long}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="modelPreference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tai.modelPreference}</FormLabel>
                  <Select value={field.value || NONE} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={tai.useWorkspaceDefault} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{tai.useWorkspaceDefault}</SelectItem>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tai.cancel}
              </Button>
              <Button type="submit" disabled={updateAccount.isPending}>
                {updateAccount.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {tai.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
