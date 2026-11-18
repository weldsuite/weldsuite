/**
 * Markdown of text tiles and comments, rendered the way the platform renders
 * Markdown elsewhere (react-markdown + GitHub flavour, as WeldMerge and the
 * agent chat do): raw HTML is never rendered and unsafe link protocols are
 * dropped by react-markdown itself. Images are not shown either, so a text
 * tile on a public share page cannot load anything from another site; links
 * open in a new tab without a referrer.
 */

import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@weldsuite/ui/lib/utils';

const REMARK_PLUGINS = [remarkGfm];
const DISALLOWED = ['img'];

const COMPONENTS: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-md border">
      <table {...props} className="my-0 w-full text-sm" />
    </div>
  ),
};

export function MarkdownText({ children, className }: Readonly<{ children: string; className?: string }>) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words text-foreground dark:prose-invert',
        'prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-semibold',
        'prose-code:before:content-none prose-code:after:content-none prose-th:px-2 prose-td:px-2',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} disallowedElements={DISALLOWED} unwrapDisallowed>
        {children}
      </Markdown>
    </div>
  );
}
