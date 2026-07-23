
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '@/lib/router';
import {
  ChevronLeft,
  Globe,
  Lock,
  Tag,
  FolderOpen,
  Clock,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Input } from '@weldsuite/ui/components/input';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { useCreateArticle, useUpdateArticle, useDeleteArticle, useHelpdeskFolders } from '@/hooks/queries/use-helpdesk-queries';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/provider';
import { DocumentEditorPage } from '@/components/document-editor-page';

interface FolderOption {
  id: string;
  name: string;
  path?: string | null;
  level?: number;
}

interface Article {
  id: string;
  title: string;
  content: string;
  excerpt: string;
  category: string;
  categoryId?: string | null;
  tags: string[];
  author: string;
  status: 'published' | 'draft' | 'archived' | 'review' | 'outdated';
  visibility: 'public' | 'internal';
  lastUpdated: Date;
}

interface ArticleEditorProps {
  article: Article;
}

export function ArticleEditor({ article: initialArticle }: ArticleEditorProps) {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [article, setArticle] = useState(initialArticle);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initialArticle.categoryId ?? null);
  const isNewArticle = article.id === 'new';

  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  // Track current content for save
  const currentContentRef = useRef(article.content);
  const currentTitleRef = useRef(article.title);

  const createArticleMutation = useCreateArticle();
  const updateArticleMutation = useUpdateArticle();
  const deleteArticleMutation = useDeleteArticle();

  // Fetch folders via hook
  const { data: foldersData } = useHelpdeskFolders();
  const folders: FolderOption[] = (foldersData?.data || []) as FolderOption[];

  // The article's folder is keyed by categoryId (the canonical FK). Keep the
  // selector in sync once the article data is available.
  useEffect(() => {
    setSelectedFolderId(initialArticle.categoryId ?? null);
  }, [initialArticle.categoryId]);

  const handleContentChange = useCallback((html: string) => {
    currentContentRef.current = html;
  }, []);

  const handleTitleChange = useCallback((text: string) => {
    currentTitleRef.current = text;
    setArticle(prev => ({ ...prev, title: text }));
  }, []);

  const handleSave = async () => {
    setIsSaving(true);

    try {
      const content = currentContentRef.current;
      const title = currentTitleRef.current || article.title;
      const excerpt = article.excerpt || content.replace(/<[^>]*>/g, '').slice(0, 200).trim();

      const articleData = {
        title: title || 'Untitled',
        content,
        excerpt,
        // `folderId` maps to the category_id FK server-side; null clears it.
        folderId: selectedFolderId,
        tags: article.tags,
        status: article.status,
        visibility: article.visibility,
      };

      const mutation = isNewArticle ? createArticleMutation : updateArticleMutation;
      const mutationArgs = isNewArticle
        ? articleData
        : { id: article.id, data: articleData };

      mutation.mutate(mutationArgs as any, {
        onSuccess: (result: any) => {
          toast.success(isNewArticle ? t.helpdesk.knowledgeEditor.articleCreated : t.helpdesk.knowledgeEditor.articleSaved);

          if (result?.article || result?.data) {
            const savedArticle = result.article || result.data;
            setArticle(prev => ({
              ...prev,
              id: savedArticle.id,
              content,
              excerpt,
              lastUpdated: savedArticle.updatedAt ? new Date(savedArticle.updatedAt) : new Date(),
            }));

            if (isNewArticle) {
              setTimeout(() => {
                router.push(`/welddesk/knowledge/${savedArticle.id}`);
              }, 500);
            }
          }
        },
        onError: (error: any) => {
          toast.error(error instanceof Error ? error.message : t.helpdesk.knowledgeEditor.failedToSaveArticle);
        },
        onSettled: () => {
          setIsSaving(false);
        },
      });
      return;
    } catch (error) {
      toast.error(error instanceof Error ? (error as Error).message : t.helpdesk.knowledgeEditor.failedToSaveArticle);
      setIsSaving(false);
    }
  };

  // Keyboard shortcut for save
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [article]);

  const handleDelete = async () => {
    if (!confirm(t.helpdesk.knowledgeEditor.confirmDeleteArticle)) {
      return;
    }

    setIsSaving(true);
    deleteArticleMutation.mutate(article.id, {
      onSuccess: () => {
        toast.success(t.helpdesk.knowledgeEditor.articleDeleted);
        router.push('/welddesk/knowledge');
      },
      onError: (error: any) => {
        toast.error(error instanceof Error ? error.message : t.helpdesk.knowledgeEditor.failedToDeleteArticle);
      },
      onSettled: () => {
        setIsSaving(false);
      },
    });
  };

  const getStatusColor = (status: Article['status']) => {
    switch (status) {
      case 'published': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
      case 'draft': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
      case 'archived': return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
      case 'review': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
      case 'outdated': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400';
    }
  };

  // ── Sidebar ──────────────────────────────────────────────────────────────

  const sidePanel = (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{t.helpdesk.knowledgeEditor.articleSettings}</h3>
        <Badge className={cn(
          "text-xs font-medium capitalize rounded-sm border-transparent",
          article.status === 'draft' && 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400',
          article.status === 'published' && 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
          article.status === 'archived' && 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-400',
          article.status === 'review' && 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
          article.status === 'outdated' && 'bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400',
        )}>
          {article.status}
        </Badge>
      </div>

      <div className="space-y-4">
        {/* Status */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledgeEditor.status}</label>
          <Select
            value={article.status}
            onValueChange={(value: Article['status']) =>
              setArticle({ ...article, status: value })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">{t.helpdesk.knowledgeEditor.statusDraft}</SelectItem>
              <SelectItem value="review">{t.helpdesk.knowledgeEditor.statusInReview}</SelectItem>
              <SelectItem value="published">{t.helpdesk.knowledgeEditor.statusPublished}</SelectItem>
              <SelectItem value="outdated">{t.helpdesk.knowledgeEditor.statusOutdated}</SelectItem>
              <SelectItem value="archived">{t.helpdesk.knowledgeEditor.statusArchived}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Visibility */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledgeEditor.visibility}</label>
          <Select
            value={article.visibility}
            onValueChange={(value: Article['visibility']) =>
              setArticle({ ...article, visibility: value })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  {t.helpdesk.knowledgeEditor.visibilityPublic}
                </div>
              </SelectItem>
              <SelectItem value="internal">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  {t.helpdesk.knowledgeEditor.visibilityInternal}
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Folder Selection */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledgeEditor.folder}</label>
          <Select
            value={selectedFolderId || '_none'}
            onValueChange={(value) => {
              const actualValue = value === '_none' ? null : value;
              setSelectedFolderId(actualValue);
              const folder = folders.find(f => f.id === actualValue);
              if (folder) {
                setArticle(prev => ({ ...prev, category: folder.path || folder.name }));
              } else {
                setArticle(prev => ({ ...prev, category: '' }));
              }
            }}
          >
            <SelectTrigger>
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder={t.helpdesk.knowledgeEditor.selectFolder} />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">
                <span className="text-muted-foreground">{t.helpdesk.knowledgeEditor.noFolder}</span>
              </SelectItem>
              {folders.map((folder) => (
                <SelectItem key={folder.id} value={folder.id}>
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-4 w-4" />
                    <span style={{ paddingLeft: `${(folder.level || 0) * 12}px` }}>
                      {folder.name}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {folders.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {t.helpdesk.knowledgeEditor.noFoldersAvailable}
            </p>
          )}
        </div>

        {/* Tags */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledge.tags}</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {article.tags.map((tag, index) => (
              <Badge
                key={index}
                variant="secondary"
                className="cursor-pointer"
                onClick={() =>
                  setArticle({
                    ...article,
                    tags: article.tags.filter((_, i) => i !== index),
                  })
                }
              >
                <Tag className="h-3 w-3 mr-1" />
                {tag}
              </Badge>
            ))}
          </div>
          <Input
            placeholder={t.helpdesk.knowledgeEditor.addTagPlaceholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.currentTarget.value) {
                e.preventDefault();
                setArticle({
                  ...article,
                  tags: [...article.tags, e.currentTarget.value],
                });
                e.currentTarget.value = '';
              }
            }}
          />
        </div>

        {/* Author */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledge.author}</label>
          <Input value={article.author} disabled className="bg-muted" />
        </div>

        {/* Last edited */}
        <div>
          <label className="text-sm font-medium mb-2 block">{t.helpdesk.knowledgeEditor.lastEdited}</label>
          <div className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {format(article.lastUpdated, 'MMM d, yyyy')}
          </div>
        </div>
      </div>
    </div>
  );

  // ── Toolbar content ──────────────────────────────────────────────────────

  const toolbarLeft = (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={() => router.push('/welddesk/knowledge')}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
    </>
  );

  const toolbarRight = (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={handleSave}
        disabled={isSaving}
      >
        {isSaving ? t.helpdesk.knowledgeEditor.saving : t.helpdesk.actions.save}
      </Button>
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Loading Overlay */}
      {isSaving && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-card p-6 rounded-lg shadow-lg flex flex-col items-center gap-3">
            <div className="h-8 w-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium">
              {isNewArticle ? t.helpdesk.knowledgeEditor.creatingArticle : t.helpdesk.knowledgeEditor.savingChanges}
            </p>
          </div>
        </div>
      )}

      <DocumentEditorPage
        initialContent={article.content}
        initialTitle={article.title}
        editable={true}
        showCoverImage={false}
        contentPlaceholder={t.helpdesk.knowledgeEditor.contentPlaceholder}
        onContentChange={handleContentChange}
        onTitleChange={handleTitleChange}
        toolbarLeft={toolbarLeft}
        toolbarRight={toolbarRight}
        sidePanel={sidePanel}
        contentRef={contentRef}
        titleRef={titleRef}
      />
    </>
  );
}
