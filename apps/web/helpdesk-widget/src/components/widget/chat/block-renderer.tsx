/**
 * BlockRenderer — Widget-side interactive message block renderer.
 *
 * Maps MessageBlock types to React components.
 * Customers can interact (click buttons, submit forms, etc.).
 * Blocks show as disabled after response.
 */

import { useState } from 'react';
import type {
  MessageBlock,
  BlockResponse,
  TextBlock,
  ButtonGroupBlock,
  InputFormBlock,
  RatingBlock,
  CardBlock,
  CarouselBlock,
  ImageBlock,
  ContextBlock,
  FileRequestBlock,
} from '@weldsuite/core-api-client/schemas/welddesk-blocks';
import { isActionResponded } from '@weldsuite/core-api-client/schemas/welddesk-blocks';

interface BlockRendererProps {
  blocks: MessageBlock[];
  responses?: Record<string, BlockResponse> | null;
  onRespond: (actionId: string, value: unknown) => void;
  role: 'customer' | 'agent';
  disabled?: boolean;
}

export function BlockRenderer({
  blocks,
  responses,
  onRespond,
  role,
  disabled = false,
}: BlockRendererProps) {
  return (
    <div className="welddesk-blocks space-y-2">
      {blocks.map((block) => (
        <BlockSwitch
          key={block.id}
          block={block}
          responses={responses}
          onRespond={onRespond}
          role={role}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function BlockSwitch({
  block,
  responses,
  onRespond,
  role,
  disabled,
}: {
  block: MessageBlock;
  responses?: Record<string, BlockResponse> | null;
  onRespond: (actionId: string, value: unknown) => void;
  role: 'customer' | 'agent';
  disabled: boolean;
}) {
  switch (block.type) {
    case 'text':
      return <TextBlockComponent block={block} />;
    case 'button_group':
      return (
        <ButtonGroupComponent
          block={block}
          response={responses?.[block.actionId]}
          onRespond={onRespond}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    case 'input_form':
      return (
        <InputFormComponent
          block={block}
          response={responses?.[block.actionId]}
          onRespond={onRespond}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    case 'rating':
      return (
        <RatingComponent
          block={block}
          response={responses?.[block.actionId]}
          onRespond={onRespond}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    case 'card':
      return (
        <CardComponent
          block={block}
          response={block.actionId ? responses?.[block.actionId] : undefined}
          onRespond={onRespond}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    case 'carousel':
      return (
        <CarouselComponent
          block={block}
          responses={responses}
          onRespond={onRespond}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    case 'image':
      return <ImageComponent block={block} />;
    case 'divider':
      return <hr className="border-gray-200 my-2" />;
    case 'context':
      return <ContextComponent block={block} />;
    case 'file_request':
      return (
        <FileRequestComponent
          block={block}
          response={responses?.[block.actionId]}
          isAgent={role === 'agent'}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}

// --------------------------------------------------------------------------
// Block Components
// --------------------------------------------------------------------------

function TextBlockComponent({ block }: { block: TextBlock }) {
  const styleClasses: Record<string, string> = {
    default: 'text-gray-900',
    muted: 'text-gray-500 text-sm',
    bold: 'text-gray-900 font-semibold',
    warning: 'text-amber-600',
    error: 'text-red-600',
  };
  return (
    <p className={`${styleClasses[block.style || 'default']} whitespace-pre-wrap`}>
      {block.content}
    </p>
  );
}

function ButtonGroupComponent({
  block,
  response,
  onRespond,
  isAgent,
  disabled,
}: {
  block: ButtonGroupBlock;
  response?: BlockResponse;
  onRespond: (actionId: string, value: unknown) => void;
  isAgent: boolean;
  disabled: boolean;
}) {
  const isResponded = !!response;
  const selectedIds: string[] =
    response?.type === 'button'
      ? (response.value as { selectedIds: string[] }).selectedIds ?? []
      : [];

  const layoutClass =
    block.layout === 'vertical'
      ? 'flex flex-col gap-2'
      : block.layout === 'grid'
        ? 'grid grid-cols-2 gap-2'
        : 'flex flex-wrap gap-2';

  return (
    <div className={layoutClass}>
      {block.buttons.map((btn) => {
        const isSelected = selectedIds.includes(btn.id);
        const isDisabled = disabled || isAgent || isResponded;

        if (btn.url) {
          return (
            <a
              key={btn.id}
              href={btn.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-blue-600 hover:bg-blue-50 transition-colors"
            >
              {btn.label}
            </a>
          );
        }

        return (
          <button
            key={btn.id}
            onClick={() => {
              if (!isDisabled) {
                onRespond(block.actionId, {
                  selectedIds: [btn.id],
                  selectedValues: [btn.value],
                });
              }
            }}
            disabled={isDisabled}
            className={`
              inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium
              transition-colors
              ${
                isSelected
                  ? 'bg-blue-600 text-white border border-blue-600'
                  : isDisabled
                    ? 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
                    : btn.style === 'primary'
                      ? 'bg-blue-600 text-white hover:bg-blue-700 border border-blue-600'
                      : btn.style === 'danger'
                        ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                        : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
              }
            `}
          >
            {isSelected && <span className="mr-1.5">&#10003;</span>}
            {btn.label}
          </button>
        );
      })}
    </div>
  );
}

function InputFormComponent({
  block,
  response,
  onRespond,
  isAgent,
  disabled,
}: {
  block: InputFormBlock;
  response?: BlockResponse;
  onRespond: (actionId: string, value: unknown) => void;
  isAgent: boolean;
  disabled: boolean;
}) {
  const isResponded = !!response;
  const submittedData =
    response?.type === 'form'
      ? (response.value as Record<string, string>)
      : undefined;

  const [formData, setFormData] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!disabled && !isAgent && !isResponded) {
      onRespond(block.actionId, formData);
    }
  };

  if (isResponded && submittedData) {
    return (
      <div className="space-y-2 rounded-lg bg-gray-50 p-3">
        {block.fields.map((field) => (
          <div key={field.id}>
            <span className="text-xs text-gray-500">{field.label}</span>
            <p className="text-sm text-gray-800">{submittedData[field.id] || '—'}</p>
          </div>
        ))}
        <p className="text-xs text-green-600">&#10003; Submitted</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {block.fields.map((field) => (
        <div key={field.id}>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            {field.label}
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {field.type === 'textarea' ? (
            <textarea
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder={field.placeholder}
              required={field.required}
              rows={3}
              disabled={isAgent || disabled}
              value={formData[field.id] || ''}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))
              }
            />
          ) : field.type === 'select' ? (
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              required={field.required}
              disabled={isAgent || disabled}
              value={formData[field.id] || ''}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))
              }
            >
              <option value="">{field.placeholder || 'Select...'}</option>
              {field.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === 'phone' ? 'tel' : field.type}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              placeholder={field.placeholder}
              required={field.required}
              disabled={isAgent || disabled}
              value={formData[field.id] || ''}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      {!isAgent && !disabled && (
        <button
          type="submit"
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          {block.submitLabel || 'Submit'}
        </button>
      )}
    </form>
  );
}

function RatingComponent({
  block,
  response,
  onRespond,
  isAgent,
  disabled,
}: {
  block: RatingBlock;
  response?: BlockResponse;
  onRespond: (actionId: string, value: unknown) => void;
  isAgent: boolean;
  disabled: boolean;
}) {
  const isResponded = !!response;
  const submittedRating =
    response?.type === 'rating'
      ? (response.value as { rating: number; feedback?: string })
      : undefined;
  const [hoverRating, setHoverRating] = useState(0);
  const [selectedRating, setSelectedRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const maxRating = block.style === 'nps' ? 10 : 5;
  const displayRating = submittedRating?.rating || selectedRating;

  const handleRate = (rating: number) => {
    if (isAgent || disabled || isResponded) return;
    setSelectedRating(rating);
    if (block.showFeedback) {
      setShowFeedback(true);
    } else {
      onRespond(block.actionId, { rating });
    }
  };

  const handleSubmitWithFeedback = () => {
    onRespond(block.actionId, { rating: selectedRating, feedback });
  };

  return (
    <div className="space-y-2">
      {block.question && (
        <p className="text-sm text-gray-700">{block.question}</p>
      )}
      <div className="flex gap-1">
        {Array.from({ length: maxRating }, (_, i) => i + 1).map((star) => (
          <button
            key={star}
            onClick={() => handleRate(star)}
            onMouseEnter={() => !isResponded && setHoverRating(star)}
            onMouseLeave={() => setHoverRating(0)}
            disabled={isAgent || disabled || isResponded}
            className={`text-2xl transition-colors ${
              star <= (hoverRating || displayRating)
                ? 'text-yellow-400'
                : 'text-gray-300'
            } ${isResponded ? 'cursor-default' : 'cursor-pointer hover:scale-110'}`}
          >
            {block.style === 'emoji'
              ? star <= 2
                ? '\u{1F61E}'
                : star === 3
                  ? '\u{1F610}'
                  : '\u{1F60A}'
              : '\u2605'}
          </button>
        ))}
      </div>
      {showFeedback && !isResponded && (
        <div className="space-y-2">
          <textarea
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder={block.feedbackLabel || 'Any additional feedback?'}
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button
            onClick={handleSubmitWithFeedback}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Submit
          </button>
        </div>
      )}
      {submittedRating?.feedback && (
        <p className="text-xs text-gray-500 italic">
          &ldquo;{submittedRating.feedback}&rdquo;
        </p>
      )}
      {isResponded && (
        <p className="text-xs text-green-600">&#10003; Thank you for your feedback</p>
      )}
    </div>
  );
}

function CardComponent({
  block,
  response,
  onRespond,
  isAgent,
  disabled,
}: {
  block: CardBlock;
  response?: BlockResponse;
  onRespond: (actionId: string, value: unknown) => void;
  isAgent: boolean;
  disabled: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      {block.imageUrl && (
        <img
          src={block.imageUrl}
          alt={block.imageAlt || block.title}
          className="w-full h-36 object-cover"
        />
      )}
      <div className="p-3 space-y-1.5">
        <h4 className="font-semibold text-sm text-gray-900">{block.title}</h4>
        {block.description && (
          <p className="text-xs text-gray-600">{block.description}</p>
        )}
        {block.actions && block.actions.length > 0 && (
          <div className="flex gap-2 pt-1">
            {block.actions.map((action) => {
              const isSelected =
                response?.type === 'button' &&
                (response.value as { selectedIds: string[] }).selectedIds?.includes(action.id);

              return action.url ? (
                <a
                  key={action.id}
                  href={action.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-blue-600 hover:underline"
                >
                  {action.label}
                </a>
              ) : (
                <button
                  key={action.id}
                  onClick={() => {
                    if (!isAgent && !disabled && !response && block.actionId) {
                      onRespond(block.actionId, {
                        selectedIds: [action.id],
                        selectedValues: [action.value],
                      });
                    }
                  }}
                  disabled={isAgent || disabled || !!response}
                  className={`text-xs font-medium px-3 py-1 rounded ${
                    isSelected
                      ? 'bg-blue-600 text-white'
                      : action.style === 'primary'
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  {isSelected && '&#10003; '}
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CarouselComponent({
  block,
  responses,
  onRespond,
  isAgent,
  disabled,
}: {
  block: CarouselBlock;
  responses?: Record<string, BlockResponse> | null;
  onRespond: (actionId: string, value: unknown) => void;
  isAgent: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory">
      {block.cards.map((card) => (
        <div key={card.id} className="min-w-[240px] max-w-[280px] snap-start flex-shrink-0">
          <CardComponent
            block={card}
            response={card.actionId ? responses?.[card.actionId] : undefined}
            onRespond={onRespond}
            isAgent={isAgent}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

function ImageComponent({ block }: { block: ImageBlock }) {
  return (
    <figure className="space-y-1">
      <img
        src={block.url}
        alt={block.alt || ''}
        className="rounded-lg max-w-full max-h-64 object-contain"
      />
      {block.caption && (
        <figcaption className="text-xs text-gray-500">{block.caption}</figcaption>
      )}
    </figure>
  );
}

function ContextComponent({ block }: { block: ContextBlock }) {
  return <p className="text-xs text-gray-400 italic">{block.content}</p>;
}

function FileRequestComponent({
  block,
  response,
  isAgent,
  disabled,
}: {
  block: FileRequestBlock;
  response?: BlockResponse;
  isAgent: boolean;
  disabled: boolean;
}) {
  const isResponded = !!response;
  const files =
    response?.type === 'file'
      ? (response.value as { files: Array<{ fileName: string }> }).files
      : [];

  if (isResponded) {
    return (
      <div className="rounded-lg bg-gray-50 p-3 space-y-1">
        {files.map((f, i) => (
          <p key={i} className="text-sm text-gray-700">
            &#128206; {f.fileName}
          </p>
        ))}
        <p className="text-xs text-green-600">&#10003; Uploaded</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-4 text-center">
      <p className="text-sm text-gray-600">
        {block.prompt || 'Please upload a file'}
      </p>
      {!isAgent && !disabled && (
        <p className="text-xs text-gray-400 mt-1">
          {block.accept?.join(', ') || 'Any file type'}
          {block.maxSize && ` (max ${Math.round(block.maxSize / 1024 / 1024)}MB)`}
        </p>
      )}
    </div>
  );
}
