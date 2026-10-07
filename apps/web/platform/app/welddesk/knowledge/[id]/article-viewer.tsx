
import { useState, type ReactElement } from 'react';
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
  visibility: 'public' | 'private' | 'internal' | 'logged_in' | 'specific_users' | 'restricted';
  lastUpdated: Date;
  views?: number;
  helpful?: number;
  notHelpful?: number;
}

interface ArticleViewerProps {
  article: Article;
}

type ListType = 'bullet' | 'numbered';

interface MarkdownState {
  elements: ReactElement[];
  listItems: string[];
  listType: ListType | null;
  codeBlock: string[];
  inCodeBlock: boolean;
}

const LIST_STYLES = {
  bullet: { Tag: 'ul', className: 'list-disc list-inside space-y-1 mb-4' },
  numbered: { Tag: 'ol', className: 'list-decimal list-inside space-y-1 mb-4' },
} as const;

const HEADINGS = [
  { prefix: '# ', Tag: 'h1', className: 'text-4xl font-bold mb-4 mt-8' },
  { prefix: '## ', Tag: 'h2', className: 'text-3xl font-bold mb-3 mt-6' },
  { prefix: '### ', Tag: 'h3', className: 'text-2xl font-semibold mb-3 mt-4' },
] as const;

/**
 * Pair each string with a stable React key built from its text plus how many
 * times that text has already appeared (duplicates stay unique without using
 * the array position as the key).
 */
function keyByOccurrence(items: readonly string[]): { item: string; key: string; index: number }[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const n = (seen.get(item) ?? 0) + 1;
    seen.set(item, n);
    return { item, key: `${item}#${n}`, index };
  });
}

function flushList(state: MarkdownState) {
  if (state.listItems.length === 0) return;
  if (state.listType) {
    const { Tag, className } = LIST_STYLES[state.listType];
    state.elements.push(
      <Tag key={state.elements.length} className={className}>
        {keyByOccurrence(state.listItems).map(({ item, key }) => (
          <li key={key}>{item}</li>
        ))}
      </Tag>
    );
  }
  state.listItems = [];
  state.listType = null;
}

function toggleCodeBlock(state: MarkdownState) {
  if (!state.inCodeBlock) {
    flushList(state);
    state.inCodeBlock = true;
    return;
  }
  state.elements.push(
    <pre key={state.elements.length} className="bg-muted p-4 rounded-lg overflow-x-auto mb-4">
      <code className="font-mono text-sm">{state.codeBlock.join('\n')}</code>
    </pre>
  );
  state.codeBlock = [];
  state.inCodeBlock = false;
}

function handleHeading(state: MarkdownState, line: string): boolean {
  const heading = HEADINGS.find((h) => line.startsWith(h.prefix));
  if (!heading) return false;
  flushList(state);
  const { Tag, className, prefix } = heading;
  state.elements.push(
    <Tag key={state.elements.length} className={className}>
      {line.substring(prefix.length)}
    </Tag>
  );
  return true;
}

function handleListItem(state: MarkdownState, line: string): boolean {
  let type: ListType;
  let text: string;
  if (line.startsWith('- ')) {
    type = 'bullet';
    text = line.substring(2);
  } else if (/^\d+\. /.test(line)) {
    type = 'numbered';
    text = line.replace(/^\d+\. /, '');
  } else {
    return false;
  }
  if (state.listType !== type) {
    flushList(state);
    state.listType = type;
  }
  state.listItems.push(text);
  return true;
}

function renderInlineMarkdown(line: string): string {
  return line
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">$1</code>');
}

function processMarkdownLine(state: MarkdownState, line: string) {
  if (line.startsWith('```')) {
    toggleCodeBlock(state);
    return;
  }
  if (state.inCodeBlock) {
    state.codeBlock.push(line);
    return;
  }
  if (handleHeading(state, line) || handleListItem(state, line)) return;

  flushList(state);
  const { elements } = state;
  if (line.startsWith('> ')) {
    elements.push(
      <blockquote
        key={elements.length}
        className="border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground mb-4"
      >
        {line.substring(2)}
      </blockquote>
    );
  } else if (line.trim() === '') {
    if (elements.length > 0 && elements.at(-1)!.type !== 'br') {
      elements.push(<br key={elements.length} />);
    }
  } else {
    elements.push(
      <p
        key={elements.length}
        className="mb-4 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(line) }}
      />
    );
  }
}

// Parse markdown content to HTML-like structure for display
function renderMarkdownContent(content: string): ReactElement[] {
  const state: MarkdownState = {
    elements: [],
    listItems: [],
    listType: null,
    codeBlock: [],
    inCodeBlock: false,
  };
  content.split('\n').forEach((line) => processMarkdownLine(state, line));
  flushList(state);
  return state.elements;
}

export function ArticleViewer({ article }: Readonly<ArticleViewerProps>) {
  const { t } = useI18n();
  const router = useRouter();
  const [isHelpful, setIsHelpful] = useState<boolean | null>(null);

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
      <div className="flex items-center justify-between px-4 h-[53px] border-b border-gray-200 dark:border-border bg-white dark:bg-background flex-shrink-0">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => router.push('/welddesk/help-center/articles')}
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
            className="h-8"
            onClick={() => router.push(`/welddesk/help-center/articles/${article.id}/edit`)}
          >
            {t.helpdesk.actions.edit}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <article className="max-w-3xl mx-auto px-6 py-8">
          <header className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight mb-3">{article.title}</h1>

            {article.excerpt && (
              <p className="text-sm text-muted-foreground mb-4">{article.excerpt}</p>
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
            {renderMarkdownContent(article.content)}
          </div>

          {/* Feedback Section */}
          <div className="mt-12 pt-8 border-t">
            <h3 className="text-sm font-medium mb-3">{t.helpdesk.helpArticles.wasArticleHelpful}</h3>
            <div className="flex items-center gap-2">
              <Button
                variant={isHelpful === true ? 'default' : 'outline'}
                size="sm"
                className="h-8"
                onClick={() => handleHelpful(true)}
              >
                <ThumbsUp className="h-3.5 w-3.5 mr-1.5" />
                {t.helpdesk.helpArticles.yes} {article.helpful !== undefined && `(${article.helpful})`}
              </Button>
              <Button
                variant={isHelpful === false ? 'destructive' : 'outline'}
                size="sm"
                className="h-8"
                onClick={() => handleHelpful(false)}
              >
                <ThumbsDown className="h-3.5 w-3.5 mr-1.5" />
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
