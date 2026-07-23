/**
 * Input Form Bubble Component
 * Renders a form to collect customer data for workflow interactive steps
 */

import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface FormField {
  id: string;
  label: string;
  type: 'text' | 'email' | 'phone' | 'number';
  required: boolean;
  placeholder?: string;
}

interface InputFormBubbleProps {
  messageId: string;
  content: string;
  fields: FormField[];
  submittedData?: Record<string, string>;
  onSubmit: (messageId: string, data: Record<string, string>) => void;
  isDisabled?: boolean;
}

export function InputFormBubble({
  messageId,
  content,
  fields,
  submittedData,
  onSubmit,
  isDisabled = false,
}: InputFormBubbleProps) {
  const [values, setValues] = useState<Record<string, string>>(() => submittedData || {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const hasSubmitted = !!submittedData;

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    for (const field of fields) {
      const value = values[field.id]?.trim() || '';

      if (field.required && !value) {
        newErrors[field.id] = 'Required';
        continue;
      }

      if (value && field.type === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          newErrors[field.id] = 'Invalid email';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (hasSubmitted || isDisabled || submitting) return;
    if (!validate()) return;

    setSubmitting(true);
    onSubmit(messageId, values);
  };

  const getInputType = (type: string) => {
    switch (type) {
      case 'email': return 'email';
      case 'phone': return 'tel';
      case 'number': return 'number';
      default: return 'text';
    }
  };

  const isSingleField = fields.length === 1;
  const singleField = isSingleField ? fields[0] : null;

  // Single-field inline layout (e.g., email collection)
  if (isSingleField && singleField) {
    return (
      <div className="flex flex-col items-start gap-2 max-w-[85%]">
        {/* Prompt message */}
        <div
          className="px-4 py-3 rounded-2xl bg-[#F5F5F5] text-black"
          style={{ borderBottomLeftRadius: '4px' }}
        >
          <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">
            {content}
          </p>
        </div>

        {/* Form card with label + inline input/button */}
        <div className="w-full rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="p-3">
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              {singleField.label}
              {singleField.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>

            {hasSubmitted ? (
              <p className="text-sm text-gray-800 py-1.5 px-3 bg-gray-50 rounded-lg flex items-center gap-2">
                <span className="flex-1">{submittedData?.[singleField.id] || '-'}</span>
                <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />
              </p>
            ) : (
              <>
                <div className="flex items-center gap-0">
                  <input
                    type={getInputType(singleField.type)}
                    value={values[singleField.id] || ''}
                    onChange={(e) => {
                      setValues(prev => ({ ...prev, [singleField.id]: e.target.value }));
                      if (errors[singleField.id]) {
                        setErrors(prev => {
                          const next = { ...prev };
                          delete next[singleField.id];
                          return next;
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSubmit();
                    }}
                    placeholder={singleField.placeholder || ''}
                    disabled={isDisabled || submitting}
                    className={cn(
                      'flex-1 text-sm px-3 py-2 rounded-l-lg border border-r-0 outline-none ring-0 focus:ring-0 focus:outline-none transition-colors text-gray-900 placeholder-gray-400',
                      errors[singleField.id]
                        ? 'border-red-300 focus:border-red-400'
                        : 'border-gray-200 focus:border-gray-400',
                      (isDisabled || submitting) && 'opacity-60 cursor-not-allowed'
                    )}
                  />
                  <button
                    onClick={handleSubmit}
                    disabled={isDisabled || submitting}
                    className={cn(
                      'h-[38px] w-[38px] flex items-center justify-center rounded-r-lg border border-black bg-black text-white transition-colors hover:bg-gray-800 active:bg-gray-900 shrink-0',
                      (isDisabled || submitting) && 'opacity-60 cursor-not-allowed'
                    )}
                  >
                    <ChevronRight className="h-4 w-4" strokeWidth={3} />
                  </button>
                </div>
                {errors[singleField.id] && (
                  <p className="text-xs text-red-500 mt-1">{errors[singleField.id]}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Multi-field layout (original)
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

      {/* Form */}
      <div className="w-full rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="p-3 space-y-3">
          {fields.map((field) => (
            <div key={field.id}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {field.label}
                {field.required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              {hasSubmitted ? (
                <p className="text-sm text-gray-800 py-1.5 px-3 bg-gray-50 rounded-lg">
                  {submittedData?.[field.id] || '-'}
                </p>
              ) : (
                <>
                  <input
                    type={getInputType(field.type)}
                    value={values[field.id] || ''}
                    onChange={(e) => {
                      setValues(prev => ({ ...prev, [field.id]: e.target.value }));
                      if (errors[field.id]) {
                        setErrors(prev => {
                          const next = { ...prev };
                          delete next[field.id];
                          return next;
                        });
                      }
                    }}
                    placeholder={field.placeholder || ''}
                    disabled={isDisabled || submitting}
                    className={cn(
                      'w-full text-sm px-3 py-2 rounded-lg border outline-none transition-colors text-gray-900 placeholder-gray-400',
                      errors[field.id]
                        ? 'border-red-300 focus:border-red-400'
                        : 'border-gray-200 focus:border-gray-400',
                      (isDisabled || submitting) && 'opacity-60 cursor-not-allowed'
                    )}
                  />
                  {errors[field.id] && (
                    <p className="text-xs text-red-500 mt-0.5">{errors[field.id]}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        {/* Submit button */}
        {!hasSubmitted && (
          <div className="px-3 pb-3">
            <button
              onClick={handleSubmit}
              disabled={isDisabled || submitting}
              className={cn(
                'w-full py-2.5 rounded-lg text-sm font-medium transition-colors',
                'bg-black text-white hover:bg-gray-800 active:bg-gray-900',
                (isDisabled || submitting) && 'opacity-60 cursor-not-allowed'
              )}
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
          </div>
        )}

        {/* Submitted indicator */}
        {hasSubmitted && (
          <div className="px-3 pb-3 flex items-center gap-1.5 text-xs text-green-600">
            <Check className="h-3.5 w-3.5" />
            <span>Submitted</span>
          </div>
        )}
      </div>
    </div>
  );
}
