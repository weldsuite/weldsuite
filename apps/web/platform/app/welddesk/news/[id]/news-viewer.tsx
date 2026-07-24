
import { useState, type ReactElement } from 'react';
import { useRouter } from '@/lib/router';
import {
  ArrowLeft,
  Edit,
  MoreVertical,
  Tag,
  Clock,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Share2,
  Bookmark,
  Printer,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import type { NewsArticle } from '@/hooks/queries/use-helpdesk-queries';

interface NewsViewerProps {
  article: NewsArticle;
}

export function NewsViewer({ article }: NewsViewerProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tn = t.helpdesk.news;
  const [isHelpful, setIsHelpful] = useState<boolean | null>(null);

  const getStatusColor = (status: NewsArticle['status']) => {
    switch (status) {
      case 'published':
        return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
      case 'draft':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
      case 'scheduled':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
    }
  };

  // Parse markdown content to HTML-like structure for display
  const renderContent = (content: string) => {
    const lines = content.split('\n');
    const elements: ReactElement[] = [];
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

  const handleHelpful = (helpful: boolean) => {
    setIsHelpful(helpful);
    // Note: News API doesn't have a vote endpoint - feedback is local only
    toast.success(tn.thankYouFeedback);
  };

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success(tn.linkCopied);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="border-b bg-background sticky top-0 z-10">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/welddesk/knowledge')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Badge className={getStatusColor(article.status)}>
                {article.status}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Eye className="h-4 w-4" />
              <span>{article.views.toLocaleString()} {tn.views.toLowerCase()}</span>
            </div>
            <Button
              size="sm"
              onClick={() => router.push(`/welddesk/knowledge/${article.id}/edit`)}
            >
              <Edit className="h-4 w-4 mr-0.5" />
              {tn.edit}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{tn.actions}</DropdownMenuLabel>
                <DropdownMenuItem onClick={handleShare}>
                  <Share2 className="h-4 w-4 mr-0.5" />
                  {tn.share}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handlePrint}>
                  <Printer className="h-4 w-4 mr-0.5" />
                  {tn.print}
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Bookmark className="h-4 w-4 mr-0.5" />
                  {tn.bookmark}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>{tn.viewAnalytics}</DropdownMenuItem>
                <DropdownMenuItem>{tn.versionHistory}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                <span>Updated {format(article.publishDate, 'MMMM d, yyyy')}</span>
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
            <h3 className="text-lg font-semibold mb-4">{tn.wasHelpful}</h3>
            <div className="flex items-center gap-4">
              <Button
                variant={isHelpful === true ? 'default' : 'outline'}
                size="lg"
                onClick={() => handleHelpful(true)}
              >
                <ThumbsUp className="h-5 w-5 mr-2" />
                Yes
              </Button>
              <Button
                variant={isHelpful === false ? 'destructive' : 'outline'}
                size="lg"
                onClick={() => handleHelpful(false)}
              >
                <ThumbsDown className="h-5 w-5 mr-2" />
                No
              </Button>
            </div>
            {isHelpful !== null && (
              <p className="text-sm text-muted-foreground mt-4">
                {tn.thankYouFeedback}
              </p>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
