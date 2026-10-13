"use client"

/**
 * A Send Email step on the canvas, drawn as a small compose window in the shape
 * of WeldMail's floating compose: From / To / Subject rows on a shared label
 * column and the first lines of the body. The rows say what the step is, so it
 * has no header (icon, title, type) like the other cards.
 *
 *   From     Sales
 *   To       {{contact.email}}
 *   Subject  Quick question
 *
 *   Hi {{contact.firstName}},
 *   …
 *
 * Larger than the other cards (`SEND_EMAIL_NODE_WIDTH` / `_HEIGHT`), with room
 * for `SEND_EMAIL_BODY_LINES` lines of the body.
 * Display only, like every card: a click opens the step's panel.
 */

import * as React from 'react';
import { asText, stripTags } from '@weldsuite/text';
import { cn } from '../../../lib/utils';
import { SEND_EMAIL_BODY_LINES, SEND_EMAIL_NODE_HEIGHT, SEND_EMAIL_NODE_WIDTH } from '../flow-utils';
import type { EmailStepPreview } from '../types';
import { StepCard, type StepCardState } from './step-card';

const HTML_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&nbsp;', ' '],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  // Last, so `&amp;lt;` reads `&lt;` and not `<`.
  ['&amp;', '&'],
];

/**
 * A step's body as the text a reader would see: tags gone, one line per block,
 * blank lines collapsed. For previews only, the result is never sent.
 */
export function emailBodyToText(body: string, isHtml = true): string {
  let text = body;
  if (isHtml) {
    text = stripTags(
      text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n'),
    );
    for (const [entity, char] of HTML_ENTITIES) text = text.split(entity).join(char);
  }
  const lines: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (line || lines.at(-1)) lines.push(line);
  }
  return lines.join('\n').trim();
}

/** What the card shows when the host handed over no preview: the raw config, in English. */
function previewFromConfig(config: Record<string, unknown> | undefined): EmailStepPreview {
  const field = (key: string) => (config?.[key] ? asText(config[key]) : '');
  return {
    rows: [
      { label: 'To', value: field('to') },
      { label: 'Subject', value: field('subject') },
    ],
    body: emailBodyToText(field('body'), config?.isHtml !== false),
  };
}

export function EmailStepCard({
  icon,
  title,
  typeLabel,
  preview,
  config,
  state,
  onClick,
}: Readonly<{
  icon: React.ElementType;
  title: React.ReactNode;
  typeLabel: React.ReactNode;
  preview?: EmailStepPreview;
  /** The step's config, read when there is no `preview`. */
  config?: Record<string, unknown>;
  state?: StepCardState;
  onClick?: () => void;
}>) {
  const { rows, body, bodyPlaceholder } = preview ?? previewFromConfig(config);

  return (
    <StepCard
      as="button"
      hideHeader
      icon={icon}
      title={title}
      typeLabel={typeLabel}
      width={SEND_EMAIL_NODE_WIDTH}
      height={SEND_EMAIL_NODE_HEIGHT}
      state={state}
      onClick={onClick}
    >
      <div className="flex min-h-0 flex-1 flex-col p-3 text-xs leading-4">
        {rows.map((row) => (
          <div key={row.label} className="flex h-6 flex-shrink-0 items-center">
            <span className="w-16 flex-shrink-0 text-muted-foreground">{row.label}</span>
            <span className={cn('min-w-0 truncate', row.value ? 'text-foreground' : 'text-muted-foreground/70')}>
              {row.value || row.placeholder}
            </span>
          </div>
        ))}
        <p
          className={cn(
            'mt-2 overflow-hidden whitespace-pre-line break-words',
            body ? 'text-foreground' : 'text-muted-foreground/70',
          )}
          // The clamp comes from the constant the card's height is computed from.
          style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: SEND_EMAIL_BODY_LINES }}
        >
          {body || bodyPlaceholder}
        </p>
      </div>
    </StepCard>
  );
}
