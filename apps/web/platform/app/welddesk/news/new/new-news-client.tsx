
import { useState, useTransition } from 'react';
import { useRouter } from '@/lib/router';
import { Newspaper, FileText, Settings, Eye } from 'lucide-react';
import { EntityFormLayout, type FormSection, type SummaryField } from '@/components/entity-overview/entity-form-layout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Label } from '@weldsuite/ui/components/label';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCreateNewsItem } from '@/hooks/queries/use-helpdesk-queries';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export default function NewNewsClient() {
  const router = useRouter();
  const { t } = useI18n();
  const st = useTranslations();
  const tn = t.helpdesk.newsEditor;
  const [isPending] = useTransition();
  const createNewsMutation = useCreateNewsItem();

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [category, setCategory] = useState<'company' | 'product' | 'industry' | 'announcement'>('company');
  const [tags, setTags] = useState('');
  const [coverImage, setCoverImage] = useState('');

  const handleSubmit = async () => {
    // Validate required fields
    if (!title || !content || !category) {
      toast.error(tn.validationError, {
        description: tn.titleRequired,
      });
      return;
    }

    createNewsMutation.mutate(
      {
        title,
        content,
        excerpt: excerpt || undefined,
        category,
        tags: tags ? tags.split(',').map(tag => tag.trim()).filter(Boolean) : undefined,
        coverImage: coverImage || undefined,
      },
      {
        onSuccess: () => {
          toast.success(tn.success, {
            description: tn.newsCreated,
          });
          router.push('/welddesk/news');
        },
        onError: () => {
          toast.error(tn.error, {
            description: tn.failedToCreateNews,
          });
        },
      }
    );
  };

  const sections: FormSection[] = [
    {
      title: st('sweep.welddesk.newNews.basicInformation'),
      icon: FileText,
      content: (
        <div className="space-y-4">
          <div>
            <Label htmlFor="title">{st('sweep.welddesk.newNews.titleLabel')} *</Label>
            <Input
              id="title"
              placeholder={st('sweep.welddesk.newNews.titlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="excerpt">{st('sweep.welddesk.newNews.excerptLabel')}</Label>
            <Input
              id="excerpt"
              placeholder={st('sweep.welddesk.newNews.excerptPlaceholder')}
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {st('sweep.welddesk.newNews.excerptHint')}
            </p>
          </div>
          <div>
            <Label htmlFor="content">{st('sweep.welddesk.newNews.contentLabel')} *</Label>
            <Textarea
              id="content"
              placeholder={st('sweep.welddesk.newNews.contentPlaceholder')}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
            />
          </div>
        </div>
      ),
    },
    {
      title: st('sweep.welddesk.newNews.categoryAndTags'),
      icon: Eye,
      content: (
        <div className="space-y-4">
          <div>
            <Label htmlFor="category">{st('sweep.welddesk.newNews.categoryLabel')} *</Label>
            <Select value={category} onValueChange={(value: string) => setCategory(value as 'company' | 'product' | 'industry' | 'announcement')}>
              <SelectTrigger>
                <SelectValue placeholder={st('sweep.welddesk.newNews.selectCategoryPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="company">{st('sweep.welddesk.newNews.categoryCompany')}</SelectItem>
                <SelectItem value="product">{st('sweep.welddesk.newNews.categoryProduct')}</SelectItem>
                <SelectItem value="industry">{st('sweep.welddesk.newNews.categoryIndustry')}</SelectItem>
                <SelectItem value="announcement">{st('sweep.welddesk.newNews.categoryAnnouncement')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {st('sweep.welddesk.newNews.categoryHint')}
            </p>
          </div>
          <div>
            <Label htmlFor="tags">{st('sweep.welddesk.newNews.tagsLabel')}</Label>
            <Input
              id="tags"
              placeholder={st('sweep.welddesk.newNews.tagsPlaceholder')}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {st('sweep.welddesk.newNews.tagsHint')}
            </p>
          </div>
        </div>
      ),
    },
    {
      title: st('sweep.welddesk.newNews.mediaAndSettings'),
      icon: Settings,
      content: (
        <div className="space-y-4">
          <div>
            <Label htmlFor="coverImage">{st('sweep.welddesk.newNews.coverImageLabel')}</Label>
            <Input
              id="coverImage"
              type="url"
              placeholder={st('sweep.welddesk.newNews.coverImagePlaceholder')}
              value={coverImage}
              onChange={(e) => setCoverImage(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {st('sweep.welddesk.newNews.coverImageHint')}
            </p>
          </div>
        </div>
      ),
    },
  ];

  const summaryFields: SummaryField[] = [
    { label: st('sweep.welddesk.newNews.titleLabel'), value: title || st('sweep.welddesk.newNews.noTitleEntered') },
    { label: st('sweep.welddesk.newNews.categoryLabel'), value: category.charAt(0).toUpperCase() + category.slice(1).replace(/([A-Z])/g, ' $1') },
    { label: st('sweep.welddesk.newNews.hasExcerpt'), value: excerpt ? st('sweep.welddesk.newNews.yes') : st('sweep.welddesk.newNews.no') },
    { label: st('sweep.welddesk.newNews.hasCoverImage'), value: coverImage ? st('sweep.welddesk.newNews.yes') : st('sweep.welddesk.newNews.no') },
    { label: st('sweep.welddesk.newNews.tagsLabel'), value: tags ? st('sweep.welddesk.newNews.tagsCount', { count: tags.split(',').length }) : st('sweep.welddesk.newNews.none') },
  ];

  return (
    <EntityFormLayout
      title={st('sweep.welddesk.newNews.pageTitle')}
      sections={sections}
      summaryTitle={st('sweep.welddesk.newNews.summaryTitle')}
      summaryIcon={Newspaper}
      summaryFields={summaryFields}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitText={st('sweep.welddesk.newNews.submitText')}
      cancelLink="/welddesk/news"
      showBackButton={true}
      backLink="/welddesk/news"
      backButtonText={st('sweep.welddesk.newNews.backButtonText')}
    />
  );
}
