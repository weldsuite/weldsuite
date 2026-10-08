import { createReactBlockSpec } from '@blocknote/react';
import { ExternalLink } from 'lucide-react';
import { getBlockEditorStrings } from '../strings';
import { EMBED_PROVIDERS, parseHttpsUrl, resolveEmbed, type EmbedProvider } from './embed-url';
import { UrlPrompt } from './url-prompt';

function isEmbedProvider(value: string): value is EmbedProvider {
  return (EMBED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Embeds a web page — a video, a design file, a map, any https link — in an
 * iframe. The block stores the link the user pasted (`url`); the player URL
 * is derived from it on render (see `resolveEmbed`), so a provider changing
 * its embed format only needs a code change, not a content migration.
 *
 * `provider` is only a hint for the empty state ("Paste a YouTube link…"),
 * set by the slash command that created the block.
 */
export const EmbedBlock = createReactBlockSpec(
  {
    type: 'embed',
    propSchema: {
      url: { default: '' },
      provider: { default: 'generic' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const t = getBlockEditorStrings();
      const provider = isEmbedProvider(block.props.provider) ? block.props.provider : 'generic';
      const embed = block.props.url ? resolveEmbed(block.props.url) : null;

      if (!embed) {
        if (!editor.isEditable) return <div />;
        return (
          <UrlPrompt
            placeholder={t.urlPrompt.placeholders[provider]}
            onSubmit={(value) => {
              const resolved = resolveEmbed(value);
              // Framing this app inside itself would hand the frame our own
              // origin, which the sandbox below must never get.
              if (!resolved || new URL(resolved.src).origin === window.location.origin) return false;
              editor.updateBlock(block, {
                props: { url: parseHttpsUrl(value)!.toString(), provider: resolved.provider },
              });
              return true;
            }}
          />
        );
      }

      return (
        <div contentEditable={false} className="flex w-full flex-col gap-1">
          <iframe
            src={embed.src}
            title={block.props.url}
            loading="lazy"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
            allow="fullscreen; picture-in-picture; clipboard-write; encrypted-media"
            className={
              embed.layout === 'video'
                ? 'aspect-video w-full rounded-md border bg-muted'
                : 'h-[450px] w-full rounded-md border bg-muted'
            }
          />
          <a
            href={parseHttpsUrl(block.props.url)?.toString()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">{t.urlPrompt.openLink}</span>
          </a>
        </div>
      );
    },
  },
);
