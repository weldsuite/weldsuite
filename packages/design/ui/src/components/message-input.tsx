'use client';

import React from 'react';
import { Send, Paperclip, Plus, ArrowUp } from 'lucide-react';
import { cn } from '../lib/utils';

export interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  showAttachment?: boolean;
  showActions?: boolean;
  sendButtonText?: string;
  sendButtonVariant?: 'text' | 'icon'; // New prop for button style
  backgroundVariant?: 'gray' | 'white'; // New prop for background style
  className?: string;
  onAttachmentClick?: () => void;
  onActionsClick?: () => void;
  actionButtons?: React.ReactNode;
}

export function MessageInput({
  value,
  onChange,
  onSend,
  placeholder = 'Write your message...',
  rows = 3,
  disabled = false,
  showAttachment = true,
  showActions = true,
  sendButtonText = 'Send',
  sendButtonVariant = 'text',
  backgroundVariant = 'gray',
  className,
  onAttachmentClick,
  onActionsClick,
  actionButtons,
}: MessageInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSend();
      }
    }
  };

  return (
    <div className={cn('flex-1', className)}>
      <div className={cn(
        'rounded-xl border border-gray-200 dark:border-border focus-within:border-gray-400 dark:focus-within:border-gray-500 transition-all',
        backgroundVariant === 'white'
          ? 'bg-white dark:bg-background'
          : 'bg-gray-50 dark:bg-background/50 focus-within:bg-white dark:focus-within:bg-gray-900'
      )}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full px-4 pt-4 pb-3 bg-transparent text-base text-gray-700 dark:text-muted-foreground placeholder-gray-400 focus:outline-none resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          rows={rows}
        />
        <div className="flex items-center justify-between px-3 pb-3">
          {/* Left side actions */}
          <div className="flex items-center gap-1">
            {actionButtons ? (
              actionButtons
            ) : (
              <>
                {showAttachment && (
                  <button
                    onClick={onAttachmentClick}
                    disabled={disabled}
                    className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Attach file"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                )}
                {showActions && (
                  <button
                    onClick={onActionsClick}
                    disabled={disabled}
                    className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    title="More actions"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Right side - Send button */}
          <div className="flex items-center gap-2">
            {sendButtonVariant === 'icon' ? (
              <button
                onClick={onSend}
                disabled={!value.trim() || disabled}
                className={cn(
                  'w-8 h-8 rounded-md transition-colors flex items-center justify-center',
                  value.trim() && !disabled
                    ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                    : 'bg-gray-200 dark:bg-secondary text-gray-400 dark:text-muted-foreground cursor-not-allowed'
                )}
                title="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!value.trim() || disabled}
                className={cn(
                  'px-4 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-2',
                  value.trim() && !disabled
                    ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                    : 'bg-gray-200 dark:bg-secondary text-gray-400 dark:text-muted-foreground cursor-not-allowed'
                )}
              >
                <Send className="h-3.5 w-3.5" />
                {sendButtonText}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
