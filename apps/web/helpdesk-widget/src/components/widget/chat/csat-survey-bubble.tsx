/**
 * CSAT Survey Bubble Component
 * Renders a star-rating survey inside the message list for workflow interactive steps
 */

import { useState } from 'react';
import { Star, Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface CsatSurveyBubbleProps {
  messageId: string;
  content: string;
  submittedRating?: number;
  submittedFeedback?: string;
  onSubmit: (messageId: string, rating: number, feedback?: string) => void;
}

export function CsatSurveyBubble({
  messageId,
  content,
  submittedRating,
  submittedFeedback,
  onSubmit,
}: CsatSurveyBubbleProps) {
  const [hoveredStar, setHoveredStar] = useState<number | null>(null);
  const [selectedRating, setSelectedRating] = useState<number | null>(submittedRating ?? null);
  const [feedback, setFeedback] = useState(submittedFeedback ?? '');
  const [submitting, setSubmitting] = useState(false);
  const hasSubmitted = submittedRating != null;

  const handleStarClick = (star: number) => {
    if (hasSubmitted || submitting) return;
    setSelectedRating(star);
  };

  const handleSubmit = () => {
    if (hasSubmitted || submitting || selectedRating == null) return;
    setSubmitting(true);
    onSubmit(messageId, selectedRating, feedback.trim() || undefined);
  };

  const displayRating = hasSubmitted ? submittedRating : selectedRating;

  return (
    <div className="flex flex-col items-start gap-2 max-w-[85%]">
      {/* Prompt message */}
      <div
        className="px-4 py-3 rounded-2xl bg-[#F5F5F5] text-black"
        style={{
          borderBottomLeftRadius: '4px',
        }}
      >
        <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">
          {content}
        </p>
      </div>

      {/* Survey card */}
      <div className="w-full rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="p-3 space-y-3">
          {/* Star rating */}
          <div className="flex items-center justify-center gap-1.5 py-1">
            {[1, 2, 3, 4, 5].map((star) => {
              const isFilled =
                hasSubmitted
                  ? star <= (submittedRating ?? 0)
                  : star <= (hoveredStar ?? selectedRating ?? 0);

              return (
                <button
                  key={star}
                  type="button"
                  onClick={() => handleStarClick(star)}
                  onMouseEnter={() => {
                    if (!hasSubmitted && !submitting) setHoveredStar(star);
                  }}
                  onMouseLeave={() => setHoveredStar(null)}
                  disabled={hasSubmitted || submitting}
                  className={cn(
                    'p-1 transition-colors rounded',
                    hasSubmitted || submitting
                      ? 'cursor-default'
                      : 'cursor-pointer hover:scale-110 active:scale-95'
                  )}
                  aria-label={`Rate ${star} out of 5`}
                >
                  <Star
                    className={cn(
                      'h-7 w-7 transition-colors',
                      isFilled
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'fill-transparent text-gray-300'
                    )}
                  />
                </button>
              );
            })}
          </div>

          {/* Rating label */}
          {displayRating != null && (
            <p className="text-center text-xs text-gray-500">
              {displayRating}/5
            </p>
          )}

          {/* Feedback textarea (shown after selecting a rating, before submission) */}
          {!hasSubmitted && selectedRating != null && (
            <div>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Any additional feedback? (optional)"
                disabled={submitting}
                rows={3}
                className={cn(
                  'w-full text-sm px-3 py-2 rounded-lg border outline-none transition-colors text-gray-900 placeholder-gray-400 resize-none',
                  'border-gray-200 focus:border-gray-400',
                  submitting && 'opacity-60 cursor-not-allowed'
                )}
              />
            </div>
          )}

          {/* Submitted feedback (read-only) */}
          {hasSubmitted && submittedFeedback && (
            <p className="text-sm text-gray-800 py-1.5 px-3 bg-gray-50 rounded-lg">
              {submittedFeedback}
            </p>
          )}
        </div>

        {/* Submit button */}
        {!hasSubmitted && selectedRating != null && (
          <div className="px-3 pb-3">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className={cn(
                'w-full py-2.5 rounded-lg text-sm font-medium transition-colors',
                'bg-black text-white hover:bg-gray-800 active:bg-gray-900',
                submitting && 'opacity-60 cursor-not-allowed'
              )}
            >
              {submitting ? 'Submitting...' : 'Submit Rating'}
            </button>
          </div>
        )}

        {/* Submitted indicator */}
        {hasSubmitted && (
          <div className="px-3 pb-3 flex items-center gap-1.5 text-xs text-green-600">
            <Check className="h-3.5 w-3.5" />
            <span>Thanks for your feedback!</span>
          </div>
        )}
      </div>
    </div>
  );
}
