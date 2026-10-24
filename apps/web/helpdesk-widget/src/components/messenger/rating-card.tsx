import { useState } from 'react';
import { Loader2, Star } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { fill, t } from '@/lib/i18n';
import { readableOn } from './parts';

interface RatingCardProps {
  color: string;
  /** The rating already given, if any: the card then just thanks the visitor. */
  rating: number | null;
  onSubmit: (rating: number, comment: string) => Promise<void>;
}

const STARS = [1, 2, 3, 4, 5];

/** CSAT after the team closed the conversation: 1–5 stars, an optional comment, then thanks. */
export function RatingCard({ color, rating, onSubmit }: Readonly<RatingCardProps>) {
  const [picked, setPicked] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');

  if (rating !== null) {
    return (
      <div className="mx-4 my-2 rounded-2xl bg-gray-50 px-3.5 py-3 text-center" data-testid="rating-done">
        <p className="text-[13px] font-semibold text-gray-900">{t.rating.thanks}</p>
        <p className="mt-0.5 text-xs text-gray-500">{fill(t.rating.rated, { rating })}</p>
      </div>
    );
  }

  const shown = hovered ?? picked ?? 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked === null) return;
    setState('sending');
    try {
      await onSubmit(picked, comment);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mx-4 my-2 rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm text-center"
      data-testid="rating-card"
    >
      <p className="text-[13px] font-semibold text-gray-900">{t.rating.prompt}</p>
      <p className="mt-0.5 text-xs text-gray-500">{t.rating.hint}</p>
      <div className="mt-2.5 flex justify-center gap-1" role="radiogroup" aria-label={t.rating.hint}>
        {STARS.map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={picked === star}
            aria-label={fill(t.rating.star, { rating: star })}
            title={t.rating.labels[star - 1]}
            data-testid={`rating-star-${star}`}
            onClick={() => setPicked(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(null)}
            className="rounded-md p-1 transition hover:scale-110"
          >
            <Star
              className={cn('h-7 w-7', star <= shown ? 'fill-amber-400 text-amber-400' : 'text-gray-300')}
            />
          </button>
        ))}
      </div>
      <p className="mt-1 h-4 text-xs text-gray-500">{shown ? t.rating.labels[shown - 1] : ''}</p>

      {picked !== null && (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={t.rating.commentPlaceholder}
            aria-label={t.rating.commentPlaceholder}
            data-testid="rating-comment"
            className="mt-2 w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-left text-sm outline-none focus:border-gray-400"
          />
          <button
            type="submit"
            disabled={state === 'sending'}
            data-testid="rating-submit"
            className="mt-2 inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
            style={{ backgroundColor: color, color: readableOn(color) }}
          >
            {state === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : t.rating.submit}
          </button>
        </>
      )}
      {state === 'error' && <p className="mt-1.5 text-xs text-red-500">{t.rating.failed}</p>}
    </form>
  );
}
