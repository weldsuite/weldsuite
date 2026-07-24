
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import {
  ArrowLeft,
  Edit,
  Eye,
  Calendar,
  User,
  Folder,
  Tag,
  ThumbsUp,
  ThumbsDown,
  EllipsisVertical,
  Trash2,
  Archive,
  CheckCircle,
  FileText,
  Clock,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';

interface Article {
  id: string;
  title: string;
  content: string;
  excerpt: string;
  category: string;
  tags: string[];
  author: string;
  views: number;
  lastUpdated: string;
  createdAt: string;
  status: string;
  helpful: number;
  notHelpful: number;
  coverImage?: string;
}

interface ArticleViewClientProps {
  article: Article;
}

export function ArticleViewClient({ article }: ArticleViewClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const th = t.helpdesk.helpArticles;

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: th.helpArticles, href: "/welddesk/help" },
    { label: article.title },
  ]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'published':
        return 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800';
      case 'draft':
        return 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
      case 'archived':
        return 'bg-gray-50 text-gray-700 dark:bg-background/20 dark:text-muted-foreground border-gray-200 dark:border-border';
      default:
        return '';
    }
  };

  const StatusIcon = ({ status }: { status: string }) => {
    switch (status) {
      case 'published':
        return <CheckCircle className="h-3 w-3" />;
      case 'draft':
        return <FileText className="h-3 w-3" />;
      case 'archived':
        return <Archive className="h-3 w-3" />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-background sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/welddesk/help')}
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                {th.backToArticles}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/welddesk/help/${article.id}/edit`)}
                className="gap-2"
              >
                <Edit className="h-4 w-4" />
                {th.edit}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem>
                    <Archive className="h-4 w-4 mr-0.5" />
                    {th.archive}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                    {th.delete}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>

      {/* Article Content */}
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
          {/* Main Content */}
          <div className="space-y-6">
            {/* Cover Image */}
            {article.coverImage && (
              <div className="rounded-lg overflow-hidden border border-border/50">
                <img
                  src={article.coverImage}
                  alt={article.title}
                  className="w-full h-auto object-cover"
                />
              </div>
            )}

            {/* Title and Status */}
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <h1 className="text-3xl font-bold text-foreground">{article.title}</h1>
                <Badge
                  variant="outline"
                  className={`inline-flex items-center gap-1 ${getStatusColor(article.status)}`}
                >
                  <StatusIcon status={article.status} />
                  {article.status.charAt(0).toUpperCase() + article.status.slice(1)}
                </Badge>
              </div>

              {/* Excerpt */}
              {article.excerpt && (
                <p className="text-lg text-muted-foreground leading-relaxed">
                  {article.excerpt}
                </p>
              )}
            </div>

            {/* Article Body */}
            <div className="prose prose-neutral dark:prose-invert max-w-none">
              <div
                dangerouslySetInnerHTML={{ __html: article.content }}
                className="[&>h1]:text-2xl [&>h1]:font-bold [&>h1]:mb-4 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:mt-8 [&>h2]:mb-4 [&>h3]:text-lg [&>h3]:font-medium [&>h3]:mt-6 [&>h3]:mb-3 [&>p]:mb-4 [&>p]:leading-relaxed [&>ul]:mb-4 [&>ul]:list-disc [&>ul]:pl-6 [&>ol]:mb-4 [&>ol]:list-decimal [&>ol]:pl-6 [&>li]:mb-2 [&>blockquote]:border-l-4 [&>blockquote]:border-border [&>blockquote]:pl-4 [&>blockquote]:italic [&>blockquote]:text-muted-foreground [&>pre]:bg-muted [&>pre]:p-4 [&>pre]:rounded-lg [&>pre]:overflow-x-auto [&>code]:bg-muted [&>code]:px-1.5 [&>code]:py-0.5 [&>code]:rounded [&>code]:text-sm"
              />
            </div>

            {/* Feedback Section */}
            <div className="border-t border-border/50 pt-6 mt-8">
              <p className="text-sm text-muted-foreground mb-4">{th.wasArticleHelpful}</p>
              <div className="flex items-center gap-4">
                <Button variant="outline" size="sm" className="gap-2">
                  <ThumbsUp className="h-4 w-4" />
                  {th.yes} ({article.helpful})
                </Button>
                <Button variant="outline" size="sm" className="gap-2">
                  <ThumbsDown className="h-4 w-4" />
                  {th.no} ({article.notHelpful})
                </Button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Article Info Card */}
            <div className="rounded-lg border border-border/50 p-4 space-y-4">
              <h3 className="font-medium text-sm text-foreground">{th.articleInformation}</h3>

              <div className="space-y-3">
                {/* Author */}
                {article.author && (
                  <div className="flex items-center gap-3 text-sm">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{th.author}:</span>
                    <span className="text-foreground">{article.author}</span>
                  </div>
                )}

                {/* Category */}
                {article.category && (
                  <div className="flex items-center gap-3 text-sm">
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{th.category}:</span>
                    <span className="text-foreground">{article.category}</span>
                  </div>
                )}

                {/* Views */}
                <div className="flex items-center gap-3 text-sm">
                  <Eye className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{th.views}:</span>
                  <span className="text-foreground">{article.views.toLocaleString()}</span>
                </div>

                {/* Created */}
                {article.createdAt && (
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{th.created}:</span>
                    <span className="text-foreground">
                      {format(new Date(article.createdAt), 'MMM d, yyyy')}
                    </span>
                  </div>
                )}

                {/* Last Updated */}
                {article.lastUpdated && (
                  <div className="flex items-center gap-3 text-sm">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{th.updated}:</span>
                    <span className="text-foreground">
                      {format(new Date(article.lastUpdated), 'MMM d, yyyy')}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Tags */}
            {article.tags && article.tags.length > 0 && (
              <div className="rounded-lg border border-border/50 p-4 space-y-3">
                <h3 className="font-medium text-sm text-foreground">{th.tags}</h3>
                <div className="flex flex-wrap gap-2">
                  {article.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      <Tag className="h-3 w-3 mr-1" />
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Feedback Stats */}
            <div className="rounded-lg border border-border/50 p-4 space-y-3">
              <h3 className="font-medium text-sm text-foreground">{th.feedback}</h3>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ThumbsUp className="h-4 w-4 text-green-600" />
                  <span className="text-sm text-green-600 font-medium">{article.helpful}</span>
                  <span className="text-sm text-muted-foreground">{th.helpful.toLowerCase()}</span>
                </div>
                <div className="flex items-center gap-2">
                  <ThumbsDown className="h-4 w-4 text-red-500" />
                  <span className="text-sm text-red-500 font-medium">{article.notHelpful}</span>
                  <span className="text-sm text-muted-foreground">{th.notHelpful.toLowerCase()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
