
import { useState } from 'react';
import { useRouter } from '@/lib/router';
import {
  ChevronLeft,
  Tag,
  Clock,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';

interface Article {
  id: string;
  title: string;
  content: string;
  excerpt?: string;
  category: string;
  tags: string[];
  author: string;
  status: 'published' | 'draft' | 'archived' | 'review' | 'outdated';
  visibility: 'public' | 'private' | 'internal' | 'logged_in' | 'specific_users';
  lastUpdated: Date;
  views?: number;
  helpful?: number;
  notHelpful?: number;
}

interface ArticleViewerProps {
  article: Article;
}

export function ArticleViewer({ article }: ArticleViewerProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [isHelpful, setIsHelpful] = useState<boolean | null>(null);

  // Parse markdown content to HTML-like structure for display
  const renderContent = (content: string) => {
    const lines = content.split('\n');
    const elements: JSX.Element[] = [];
    let listItems: string[] = [];
    let listType: 'bullet' | 'numbered' | null = null;
    let codeBlock: string[] = [];
    let inCodeBlock = false;

    const flushList = () => {
      if (listItems.length > 0) {
        if (listType === 'bullet') {
          elements.push(
            <ul key={elements.length} className="list-disc list-inside space-y-1 mb-4">
              {listItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          );
        } else if (listType === 'numbered') {
          elements.push(
            <ol key={elements.length} className="list-decimal list-inside space-y-1 mb-4">
              {listItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          );
        }
        listItems = [];
        listType = null;
      }
    };

    lines.forEach((line) => {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre key={elements.length} className="bg-muted p-4 rounded-lg overflow-x-auto mb-4">
              <code className="font-mono text-sm">{codeBlock.join('\n')}</code>
            </pre>
          );
          codeBlock = [];
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
        }
        return;
      }

      if (inCodeBlock) {
        codeBlock.push(line);
        return;
      }

      if (line.startsWith('# ')) {
        flushList();
        elements.push(
          <h1 key={elements.length} className="text-4xl font-bold mb-4 mt-8">
            {line.substring(2)}
          </h1>
        );
      } else if (line.startsWith('## ')) {
        flushList();
        elements.push(
          <h2 key={elements.length} className="text-3xl font-bold mb-3 mt-6">
            {line.substring(3)}
          </h2>
        );
      } else if (line.startsWith('### ')) {
        flushList();
        elements.push(
          <h3 key={elements.length} className="text-2xl font-semibold mb-3 mt-4">
            {line.substring(4)}
          </h3>
        );
      } else if (line.startsWith('- ')) {
        if (listType !== 'bullet') {
          flushList();
          listType = 'bullet';
        }
        listItems.push(line.substring(2));
      } else if (line.match(/^\d+\. /)) {
        if (listType !== 'numbered') {
          flushList();
          listType = 'numbered';
        }
        listItems.push(line.replace(/^\d+\. /, ''));
      } else if (line.startsWith('> ')) {
        flushList();
        elements.push(
          <blockquote
            key={elements.length}
            className="border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground mb-4"
          >
            {line.substring(2)}
          </blockquote>
        );
      } else if (line.trim() === '') {
        flushList();
        if (elements.length > 0 && elements[elements.length - 1].type !== 'br') {
          elements.push(<br key={elements.length} />);
        }
      } else {
        flushList();
        // Parse inline markdown
        let content = line;
        // Bold
        content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        // Italic
        content = content.replace(/\*(.*?)\*/g, '<em>$1</em>');
        // Inline code
        content = content.replace(/`(.*?)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">$1</code>');

        elements.push(
          <p
            key={elements.length}
            className="mb-4 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        );
      }
    });

    flushList();

    return elements;
  };

  /**
   * Record whether this article was helpful.
   *
   * TODO(welddesk-article-vote): NOT PERSISTED — the selection is local to this
   * view and is lost on navigate. This needs `POST /api/articles/:id/vote` on
   * app-api (incrementing helpdeskArticles.helpfulCount / notHelpfulCount);
   * once that exists, call it here and restore a success/failure toast.
   *
   * It has never persisted: this posted to `/helpdesk/articles/:id/vote` on the
   * legacy api-worker, whose helpdesk router mounts no `/articles` at all, so
   * every click 404'd and showed the failure toast. app-api has no authenticated
   * equivalent — the only vote route is
   * `POST /public/helpcenter/articles/:id/feedback`, which is the unauthenticated
   * public help-center surface (it resolves its tenant from the request host and
   * only accepts `published` articles), so it cannot serve this internal viewer,
   * which also shows drafts.
   *
   * The dead request is dropped rather than left pointing at api-worker: it kept
   * the legacy client alive for a call that could only ever fail. No success
   * toast is shown, because nothing is recorded — claiming otherwise would be
   * worse than the silence.
   */
  const handleHelpful = (helpful: boolean) => {
    setIsHelpful(helpful);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header — matches edit page toolbar design */}
      <div className="bg-background sticky top-0 z-10 w-full border-b">
        <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => router.push('/welddesk/knowledge')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
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
            <Button
              size="sm"
              onClick={() => router.push(`/welddesk/knowledge/${article.id}/edit`)}
            >
              {t.helpdesk.actions.edit}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <article className="max-w-4xl mx-auto px-8 py-12">
          {/* Article Header */}
          <header className="mb-8">
            <h1 className="text-5xl font-bold mb-4">{article.title}</h1>

            {article.excerpt && (
              <p className="text-xl text-muted-foreground mb-6">{article.excerpt}</p>
            )}

            {/* Metadata */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>By {article.author}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span>Updated {format(article.lastUpdated, 'MMMM d, yyyy')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" />
                <span>{article.category}</span>
              </div>
            </div>

            {/* Tags */}
            {article.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {article.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </header>

          {/* Article Content */}
          <div className="prose prose-lg max-w-none dark:prose-invert">
            {renderContent(article.content)}
          </div>

          {/* Feedback Section */}
          <div className="mt-12 pt-8 border-t">
            <h3 className="text-lg font-semibold mb-4">{t.helpdesk.helpArticles.wasArticleHelpful}</h3>
            <div className="flex items-center gap-4">
              <Button
                variant={isHelpful === true ? 'default' : 'outline'}
                size="lg"
                onClick={() => handleHelpful(true)}
              >
                <ThumbsUp className="h-5 w-5 mr-2" />
                {t.helpdesk.helpArticles.yes} {article.helpful !== undefined && `(${article.helpful})`}
              </Button>
              <Button
                variant={isHelpful === false ? 'destructive' : 'outline'}
                size="lg"
                onClick={() => handleHelpful(false)}
              >
                <ThumbsDown className="h-5 w-5 mr-2" />
                {t.helpdesk.helpArticles.no} {article.notHelpful !== undefined && `(${article.notHelpful})`}
              </Button>
            </div>
            {isHelpful !== null && (
              <p className="text-sm text-muted-foreground mt-4">
                {t.helpdesk.knowledgeEditor.feedbackSubmitted}
              </p>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
