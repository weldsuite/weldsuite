'use client';

import React, { useRef, useEffect, useState } from 'react';
import { AtSign, Image, Paperclip, Settings, Plus, Mic, X, FileText } from 'lucide-react';
import { cn } from '../lib/utils';
import { MessageInput } from './message-input';

export interface AttachmentPreview {
  id: string;
  file: File;
  name: string;
  size: string;
  type: 'image' | 'file';
  previewUrl?: string;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export interface WeldAgentInputProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Called when the user sends. When `enableAttachments` is set, any pending
   * attachments are passed as the first argument.
   */
  onSend: (attachments?: AttachmentPreview[]) => void | Promise<void>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  onMentionClick?: () => void;
  onImageClick?: () => void;
  onAttachClick?: () => void;
  onSettingsClick?: () => void;
  /**
   * Enables the built-in attachment picker / preview UI. When true the
   * component renders the attachment-capable layout (plus button opens a file
   * picker, selected files are previewed and passed to `onSend`).
   */
  enableAttachments?: boolean;
  /**
   * Extra action nodes rendered on the left side of the action bar, next to
   * the attachment/plus button. Only used by the attachment-capable layout.
   */
  extraLeftActions?: React.ReactNode;
  onPlusClick?: () => void;
  onMicClick?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImageFile(fileName: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
  return imageExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
}

export function WeldAgentInput({
  value,
  onChange,
  onSend,
  placeholder = 'Ask WeldAgent anything...',
  rows = 1,
  disabled = false,
  className,
  onMentionClick,
  onImageClick,
  onAttachClick,
  onSettingsClick,
  enableAttachments = false,
  extraLeftActions,
  onPlusClick,
  onMicClick,
}: WeldAgentInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);

  // Auto-resize textarea with max height limit (attachment layout only)
  const maxHeight = 200;
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, maxHeight);
      textareaRef.current.style.height = `${newHeight}px`;
      textareaRef.current.style.overflowY = textareaRef.current.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  }, [value]);

  // ---------------------------------------------------------------------------
  // Backward-compatible default layout (MessageInput-based, no attachments).
  // Preserves the existing API used by other apps.
  // ---------------------------------------------------------------------------
  if (!enableAttachments) {
    return (
      <MessageInput
        value={value}
        onChange={onChange}
        onSend={() => onSend()}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
        sendButtonVariant="icon"
        backgroundVariant="white"
        showAttachment={false}
        showActions={false}
        actionButtons={
          <>
            <button
              onClick={onMentionClick}
              disabled={disabled}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Mention"
            >
              <AtSign className="h-4 w-4" />
            </button>
            <button
              onClick={onImageClick}
              disabled={disabled}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Add image"
            >
              <Image className="h-4 w-4" />
            </button>
            <button
              onClick={onAttachClick}
              disabled={disabled}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              onClick={onSettingsClick}
              disabled={disabled}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          </>
        }
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Attachment-capable layout.
  // ---------------------------------------------------------------------------
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if ((!value.trim() && attachments.length === 0) || disabled) return;
    onSend(attachments.length > 0 ? attachments : undefined);
    // Reset attachments after sending
    setAttachments([]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newAttachments: AttachmentPreview[] = Array.from(files).map(file => {
      const isImage = isImageFile(file.name);
      return {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        name: file.name,
        size: formatFileSize(file.size),
        type: isImage ? 'image' : 'file',
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      };
    });

    setAttachments(prev => [...prev, ...newAttachments].slice(0, 5)); // Max 5 attachments

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const attachment = prev.find(a => a.id === id);
      if (attachment?.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return prev.filter(a => a.id !== id);
    });
  };

  const handlePlusClick = () => {
    if (onPlusClick) {
      onPlusClick();
    } else {
      fileInputRef.current?.click();
    }
  };

  const hasContent = value.trim() || attachments.length > 0;

  return (
    <div
      className={cn(
        'bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[20px] p-[10px] min-h-[102px] w-full max-w-[768px] mx-auto flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)]',
        className
      )}
    >
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx"
      />

      {/* Attachments Preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3 px-[10px]">
          {attachments.map(attachment => (
            <div key={attachment.id} className="relative group">
              {attachment.type === 'image' && attachment.previewUrl ? (
                <div className="relative">
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-16 w-auto rounded-lg border border-gray-200 dark:border-border object-cover"
                  />
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute -top-1.5 -right-1.5 p-1 bg-gray-900 dark:bg-accent rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3 text-white" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-gray-100 dark:bg-secondary rounded-lg px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-700 dark:text-muted-foreground truncate max-w-[120px]">{attachment.name}</p>
                    <p className="text-xs text-gray-400">{attachment.size}</p>
                  </div>
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="p-0.5 hover:bg-gray-200 dark:hover:bg-accent rounded"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="w-full bg-transparent text-[15px] text-gray-900 dark:text-foreground placeholder:text-gray-500 dark:placeholder:text-muted-foreground outline-none resize-none min-h-[24px] pl-[10px] pt-[7px] scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}
      />

      {/* Bottom Actions */}
      <div className="flex items-center justify-between mt-auto">
        {/* Left - Plus and extra actions */}
        <div className="flex items-center gap-0">
          <button
            onClick={handlePlusClick}
            disabled={disabled}
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Add attachment"
          >
            <Plus className="h-[18px] w-[18px]" />
          </button>
          {extraLeftActions}
        </div>

        {/* Right - Mic and Send */}
        <div className="flex items-center gap-2">
          <button
            onClick={onMicClick}
            disabled={disabled}
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Voice input"
          >
            <Mic className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={handleSend}
            disabled={disabled || !hasContent}
            className={cn(
              'w-8 h-8 rounded-[12px] flex items-center justify-center transition-all',
              hasContent && !disabled
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-gray-300 dark:bg-muted text-gray-500 dark:text-muted-foreground cursor-not-allowed'
            )}
            title="Send message"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className={cn("h-[15px] w-[15px]", hasContent && !disabled ? "text-primary-foreground" : "text-gray-500 dark:text-muted-foreground")}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
