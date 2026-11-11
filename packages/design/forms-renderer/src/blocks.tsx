import type { ReactNode } from 'react';
import type {
  AnswerError,
  AnswerValue,
  Block,
  FieldBlock,
  FormMedia,
  GroupBlock,
  StatementBlock,
} from '@weldsuite/forms-engine';
import { FieldInput } from './fields/field-input';
import { useFieldEnv } from './env';
import { classNames, errorMessage, videoEmbedUrl } from './utils';

/** What the block views need from the form around them. */
export interface BlockContext {
  uid: string;
  rc: (text: string) => string;
  answers: Record<string, unknown>;
  errors: Record<string, AnswerError>;
  numbers: Map<string, number>;
  showNumbers: boolean;
  onChange: (fieldId: string, value: AnswerValue | undefined) => void;
}

export function MediaView({ media, className }: { media: FormMedia; className?: string }) {
  if (media.kind === 'image') {
    return <img className={classNames('wf-media', className)} src={media.url} alt={media.alt ?? ''} />;
  }
  const embed = videoEmbedUrl(media.url);
  if (embed) {
    return (
      <div className={classNames('wf-media wf-media-video', className)}>
        <iframe src={embed} title={media.alt ?? 'Video'} allow="fullscreen; picture-in-picture" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" />
      </div>
    );
  }
  return <video className={classNames('wf-media', className)} src={media.url} controls playsInline preload="metadata" aria-label={media.alt} />;
}

/** Media shown in the flow of the step (above the title). Split and background media are laid out by the step. */
export function InlineMedia({ media }: { media: FormMedia | undefined }) {
  if (!media || media.placement !== 'above') return null;
  return <MediaView media={media} />;
}

function Heading({
  id,
  level,
  number,
  required,
  children,
  className,
}: {
  id: string;
  level: 2 | 3;
  number: number | undefined;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { labels } = useFieldEnv();
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <Tag id={id} className={classNames('wf-title', className)}>
      {number !== undefined ? (
        <span className="wf-number" aria-hidden="true">
          {number}
        </span>
      ) : null}
      <span>{children}</span>
      {required ? (
        <>
          <span className="wf-required" aria-hidden="true">
            *
          </span>
          <span className="wf-sr-only"> ({labels.required})</span>
        </>
      ) : null}
    </Tag>
  );
}

export function FieldView({ field, ctx, level }: { field: FieldBlock; ctx: BlockContext; level: 2 | 3 }) {
  const { labels } = useFieldEnv();
  const inputId = `${ctx.uid}-${field.id}`;
  const error = ctx.errors[field.id] ?? null;
  const errorId = `${inputId}-error`;
  const descId = `${inputId}-desc`;
  const describedBy = [field.description ? descId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="wf-field" data-field-id={field.id} data-field-type={field.type} data-invalid={error ? true : undefined}>
      <InlineMedia media={field.media} />
      <Heading id={`${inputId}-label`} level={level} number={ctx.showNumbers ? ctx.numbers.get(field.id) : undefined} required={field.required}>
        {ctx.rc(field.title)}
      </Heading>
      {field.description ? (
        <p id={descId} className="wf-description">
          {ctx.rc(field.description)}
        </p>
      ) : null}
      <div className="wf-input-area">
        <FieldInput
          field={field}
          value={ctx.answers[field.id]}
          onChange={(value) => ctx.onChange(field.id, value)}
          error={error}
          inputId={inputId}
          describedBy={describedBy}
        />
      </div>
      {error ? (
        <p id={errorId} className="wf-error" role="alert">
          {errorMessage(labels, error, field)}
        </p>
      ) : null}
    </div>
  );
}

export function StatementView({ block, ctx, level }: { block: StatementBlock; ctx: BlockContext; level: 2 | 3 }) {
  return (
    <div className="wf-field wf-statement" data-block-id={block.id}>
      <InlineMedia media={block.media} />
      <Heading id={`${ctx.uid}-${block.id}-label`} level={level} number={undefined}>
        {ctx.rc(block.title)}
      </Heading>
      {block.description ? <p className="wf-description">{ctx.rc(block.description)}</p> : null}
    </div>
  );
}

export function GroupView({ block, ctx }: { block: GroupBlock; ctx: BlockContext }) {
  return (
    <div className="wf-group" data-block-id={block.id} role="group" aria-labelledby={`${ctx.uid}-${block.id}-label`}>
      <InlineMedia media={block.media} />
      <Heading id={`${ctx.uid}-${block.id}-label`} level={2} number={undefined} className="wf-group-title">
        {ctx.rc(block.title)}
      </Heading>
      {block.description ? <p className="wf-description">{ctx.rc(block.description)}</p> : null}
      <div className="wf-group-children">
        {block.children.map((child) =>
          child.type === 'statement' ? (
            <StatementView key={child.id} block={child} ctx={ctx} level={3} />
          ) : (
            <FieldView key={child.id} field={child} ctx={ctx} level={3} />
          ),
        )}
      </div>
    </div>
  );
}

/** One top-level block: a field, a statement or a group. Page breaks render nothing. */
export function BlockView({ block, ctx }: { block: Block; ctx: BlockContext }) {
  if (block.type === 'page_break') return null;
  if (block.type === 'group') return <GroupView block={block} ctx={ctx} />;
  if (block.type === 'statement') return <StatementView block={block} ctx={ctx} level={2} />;
  return <FieldView field={block} ctx={ctx} level={2} />;
}
