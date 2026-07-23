/**
 * Message Input Component
 * Matches the platform's customer detail panel comment input design
 * With file attachment support
 */

import { useState, useRef } from 'react';
import { Plus, X, FileText, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface Attachment {
  id: string;
  file: File;
  name: string;
  size: string;
  type: 'image' | 'file';
  previewUrl?: string;
}

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments?: Attachment[]) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  buttonColor?: string;
  buttonTextColor?: string;
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

export function MessageInput({
  value,
  onChange,
  onSend,
  onFocus,
  onBlur,
  placeholder = 'Type a message...',
  disabled = false,
  buttonColor,
  buttonTextColor,
}: MessageInputProps) {
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResizeInput = () => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = '24px'; // Reset to minimum
      const maxHeight = 120;
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      // Only show scrollbar when content exceeds max height
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
      // Track if text has wrapped to multiple lines
      setIsMultiLine(newHeight > 24);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if ((!value.trim() && attachments.length === 0) || disabled) return;

    onSend(attachments.length > 0 ? attachments : undefined);

    // Reset state after sending
    setIsMultiLine(false);
    setAttachments([]);
    if (inputRef.current) {
      inputRef.current.style.height = '24px';
      inputRef.current.style.overflowY = 'hidden';
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    autoResizeInput();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newAttachments: Attachment[] = Array.from(files).map(file => {
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

    setAttachments(prev => [...prev, ...newAttachments]);

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

  const hasContent = value.trim() || attachments.length > 0;

  return (
    <div className="px-4 py-2">
      {/* Attachments Preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {attachments.map(attachment => (
            <div key={attachment.id} className="relative group">
              {attachment.type === 'image' && attachment.previewUrl ? (
                <div className="relative">
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-16 w-auto rounded-lg border border-gray-200 object-cover"
                  />
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute -top-1.5 -right-1.5 p-1 bg-gray-900 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3 text-white" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-700 truncate max-w-[120px]">{attachment.name}</p>
                    <p className="text-xs text-gray-400">{attachment.size}</p>
                  </div>
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="p-0.5 hover:bg-gray-200 rounded"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx"
      />

      {/* Input container */}
      <div className={cn(
        "flex-1 min-w-0 flex bg-gray-100 rounded-[23px] pl-4 pr-[7px] min-h-[46px]",
        isMultiLine ? "items-end py-[11px]" : "items-center"
      )}>
        <textarea
          ref={inputRef}
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none border-none ring-0 focus:outline-none focus:border-none focus:ring-0 text-sm text-gray-700 placeholder-gray-400 resize-none overflow-hidden",
            disabled && "cursor-not-allowed"
          )}
          style={{ height: '24px', lineHeight: '24px' }}
          rows={1}
        />

        {/* Plus button for attachments */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ml-2",
            disabled
              ? "text-gray-300 cursor-not-allowed"
              : "text-gray-400 hover:text-gray-600 hover:bg-gray-200"
          )}
        >
          <Plus className="h-5 w-5" />
        </button>

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !hasContent}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ml-1",
            hasContent && !disabled && !buttonColor && "bg-gray-900 text-white hover:bg-gray-800",
            hasContent && !disabled && buttonColor && "cursor-pointer",
            (!hasContent || disabled) && "bg-gray-200 text-gray-400 cursor-not-allowed"
          )}
          style={hasContent && !disabled && buttonColor ? {
            backgroundColor: buttonColor,
            color: buttonTextColor || '#FFFFFF',
          } : undefined}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export type { Attachment };
