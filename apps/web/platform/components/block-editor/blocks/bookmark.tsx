import { createReactBlockSpec } from '@blocknote/react';
import { Globe } from 'lucide-react';
import { getBlockEditorStrings } from '../strings';
import { parseHttpsUrl } from './embed-url';
import { UrlPrompt } from './url-prompt';

/**
 * A link shown as a card. Unlike Notion's bookmark it carries no page title
 * or preview image: fetching those needs a server-side unfurl, which the
 * platform does not have, so the card shows the site and the address.
 */
export const BookmarkBlock = createReactBlockSpec(
  {
    type: 'bookmark',
    propSchema: {
      url: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const t = getBlockEditorStrings();
      const url = block.props.url ? parseHttpsUrl(block.props.url) : null;

      if (!url) {
        if (!editor.isEditable) return <div />;
        return (
          <UrlPrompt
            placeholder={t.urlPrompt.placeholders.bookmark}
            onSubmit={(value) => {
              const parsed = parseHttpsUrl(value);
              if (!parsed) return false;
              editor.updateBlock(block, { props: { url: parsed.toString() } });
              return true;
            }}
          />
        );
      }

      return (
        <a
          contentEditable={false}
          href={url.toString()}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 no-underline transition-colors hover:bg-muted/60"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Globe className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {url.hostname.replace(/^www\./, '')}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{url.toString()}</span>
          </span>
        </a>
      );
    },
  },
);
