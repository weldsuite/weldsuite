import React, { useRef, useEffect, useState } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';

export interface ReplyInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onAiDraft?: (prompt: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  leftActions?: React.ReactNode;
  rightActions?: React.ReactNode;
  showAiButton?: boolean;
  /**
   * Custom node rendered inside the AI draft toggle button.
   * Defaults to a Sparkles icon. Pass an <img> or custom SVG to brand it.
   */
  aiIcon?: React.ReactNode;
}

export function ReplyInput({
  value,
  onChange,
  onSend,
  onAiDraft,
  placeholder = 'Write your reply...',
  disabled = false,
  className,
  leftActions,
  rightActions,
  showAiButton = false,
  aiIcon,
}: ReplyInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');

  // Auto-resize textarea with max height limit
  const maxHeight = 720;
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, maxHeight);
      textareaRef.current.style.height = `${newHeight}px`;
      textareaRef.current.style.overflowY =
        textareaRef.current.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  }, [value]);

  // Focus AI input when opened
  useEffect(() => {
    if (aiPromptOpen && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 50);
    }
  }, [aiPromptOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) onSend();
    }
  };

  const handleAiSubmit = () => {
    if (aiPrompt.trim() && onAiDraft) {
      onAiDraft(aiPrompt.trim());
      setAiPrompt('');
      setAiPromptOpen(false);
    }
  };

  const handleAiKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAiSubmit();
    }
    if (e.key === 'Escape') {
      setAiPromptOpen(false);
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <div
      className={cn(
        'rounded-2xl border border-gray-200 dark:border-border bg-white dark:bg-background transition-colors focus-within:border-gray-400 dark:focus-within:border-gray-500',
        className,
      )}
    >
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="reply-input-textarea w-full min-h-[70px] max-h-[720px] resize-none border-0 focus-visible:ring-0 shadow-none pt-3 pb-2 px-4 bg-transparent text-sm text-gray-900 dark:text-foreground placeholder:text-gray-500 dark:placeholder:text-gray-400 outline-none"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}
      />

      {/* Bottom Actions */}
      <div className="flex items-center gap-1.5 px-2 pb-2">
        {!aiPromptOpen && <div className="flex items-center gap-1 flex-1">{leftActions}</div>}
        {/* AI Draft Inline Input */}
        {aiPromptOpen && showAiButton && onAiDraft && (
          <div className="flex-1 flex items-center gap-1.5 border border-violet-300/50 dark:border-violet-500/30 bg-violet-50/50 dark:bg-violet-950/20 rounded-lg pl-3 pr-1 py-1">
            <input
              ref={aiInputRef}
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={handleAiKeyDown}
              placeholder="Describe what to write..."
              className="flex-1 bg-transparent text-sm text-gray-900 dark:text-foreground placeholder:text-gray-400 outline-none"
            />
            <button
              type="button"
              onClick={handleAiSubmit}
              disabled={!aiPrompt.trim()}
              className="flex-shrink-0 h-6 w-6 flex items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-30 transition-opacity"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {showAiButton && onAiDraft && (
          <button
            type="button"
            onClick={() => setAiPromptOpen(!aiPromptOpen)}
            className={cn(
              'h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 dark:border-border transition-colors',
              aiPromptOpen
                ? 'bg-gray-100 dark:bg-secondary'
                : 'hover:bg-gray-100 dark:hover:bg-secondary',
            )}
            title="AI Draft"
          >
            {aiIcon ?? (
              <Sparkles
                className={cn(
                  'h-4 w-4 text-violet-500 transition-opacity',
                  aiPromptOpen ? 'opacity-100' : 'opacity-60 hover:opacity-100',
                )}
              />
            )}
          </button>
        )}
        {rightActions}
        <Button
          type="button"
          onClick={() => {
            if (hasContent && !disabled) onSend();
          }}
          disabled={disabled || !hasContent}
          size="sm"
          className="h-8 px-3 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
