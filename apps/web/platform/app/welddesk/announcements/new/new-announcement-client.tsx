
import { useState, useTransition } from 'react';
import { useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Megaphone, FileText, Settings, Eye } from 'lucide-react';
import { EntityFormLayout, type FormSection, type SummaryField } from '@/components/entity-overview/entity-form-layout';
import { FormInput, FormTextarea, FormField } from '@weldsuite/ui/components/form-field';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateAnnouncement } from '@/hooks/queries/use-helpdesk-queries';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';

export default function NewAnnouncementClient() {
  const { t } = useI18n();
  const ta = t.helpdesk.announcements;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const createAnnouncementMutation = useCreateAnnouncement();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: ta.title, href: '/welddesk/announcements' },
    { label: ta.newAnnouncement },
  ]);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [type, setType] = useState<'info' | 'warning' | 'success' | 'error'>('info');
  const [visibility, setVisibility] = useState<'public' | 'internal' | 'specific_groups'>('public');
  const [isPinned, setIsPinned] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');

  /* eslint-disable */
  const handleSubmit = async () => {
    // Validate required fields
    if (!title || !content) {
      toast.error(ta.validationError, {
        description: ta.fillRequiredFields,
      });
      return;
    }

    createAnnouncementMutation.mutate(
      {
        title,
        content,
        excerpt: excerpt || undefined,
        type,
        visibility,
        isPinned,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      },
      {
        onSuccess: () => {
          toast.success(ta.createdSuccessfully);
          router.push('/welddesk/announcements');
        },
        onError: () => {
          toast.error(ta.createFailed);
        },
      }
    );
  };

  const sections: FormSection[] = [
    {
      title: ta.basicInformation,
      icon: FileText,
      content: (
        <div className="space-y-4">
          <FormInput
            id="title"
            label={ta.announcementTitle}
            required
            placeholder={ta.enterTitle}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <FormInput
            id="excerpt"
            label={ta.excerpt}
            placeholder={ta.excerptPlaceholder}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            helpText={ta.excerptHelpText}
          />
          <FormTextarea
            id="content"
            label={ta.content}
            required
            placeholder={ta.enterContent}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
          />
        </div>
      ),
    },
    {
      title: ta.typeAndVisibility,
      icon: Eye,
      content: (
        <div className="space-y-4">
          <FormField
            label={ta.announcementType}
            required
            helpText={ta.typeHelpText}
          >
            <Select value={type} onValueChange={(value: any) => setType(value)}>
              <SelectTrigger>
                <SelectValue placeholder={ta.selectType} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">{ta.info}</SelectItem>
                <SelectItem value="success">{ta.success}</SelectItem>
                <SelectItem value="warning">{ta.warning}</SelectItem>
                <SelectItem value="error">{ta.error}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={ta.visibility}
            helpText={ta.visibilityHelpText}
          >
            <Select value={visibility} onValueChange={(value: any) => setVisibility(value)}>
              <SelectTrigger>
                <SelectValue placeholder={ta.selectVisibility} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">{ta.public}</SelectItem>
                <SelectItem value="internal">{ta.internalOnly}</SelectItem>
                <SelectItem value="specific_groups">{ta.specificGroups}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>
      ),
    },
    {
      title: ta.additionalSettings,
      icon: Settings,
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="isPinned">{ta.pinAnnouncement}</Label>
              <p className="text-xs text-muted-foreground">
                {ta.pinnedDescription}
              </p>
            </div>
            <Switch
              id="isPinned"
              checked={isPinned}
              onCheckedChange={setIsPinned}
            />
          </div>
          <FormInput
            id="expiresAt"
            label={ta.expirationDate}
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            helpText={ta.noExpiration}
          />
        </div>
      ),
    },
  ];

  const summaryFields: SummaryField[] = [
    { label: ta.announcementTitle, value: title || ta.noTitleEntered },
    { label: ta.type, value: type.charAt(0).toUpperCase() + type.slice(1) },
    { label: ta.visibility, value: visibility.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) },
    { label: ta.pinned, value: isPinned ? ta.yes : ta.no },
    { label: ta.expires, value: expiresAt ? new Date(expiresAt).toLocaleDateString() : ta.never },
  ];
  /* eslint-enable */

  return (
    <EntityFormLayout
      title={ta.createAnnouncement}
      sections={sections}
      summaryTitle={ta.announcementSummary}
      summaryIcon={Megaphone}
      summaryFields={summaryFields}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitText={ta.createAnnouncement}
      cancelLink="/welddesk/announcements"
      showBackButton={true}
      backLink="/welddesk/announcements"
      backButtonText={ta.backToAnnouncements}
    />
  );
}
