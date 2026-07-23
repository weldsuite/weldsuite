import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { AtSign, Image, Paperclip, Settings, ArrowUp } from 'lucide-react';

export interface CommentInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  showAtMention?: boolean;
  showImage?: boolean;
  showPaperclip?: boolean;
  showSettings?: boolean;
  onAtMentionClick?: () => void;
  onImageClick?: () => void;
  onPaperclipClick?: () => void;
  onSettingsClick?: () => void;
}

export function CommentInput({
  value,
  onChange,
  onSend,
  placeholder = 'Add a comment...',
  showAtMention = true,
  showImage = true,
  showPaperclip = true,
  showSettings = true,
  onAtMentionClick,
  onImageClick,
  onPaperclipClick,
  onSettingsClick,
}: CommentInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSend();
      }
    }
  };

  const handleSend = () => {
    if (value.trim()) {
      onSend();
    }
  };

  return (
    <div className="p-4 bg-white dark:bg-background">
      <div className="relative">
        <Textarea
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-[90px] max-h-[200px] resize-none pb-10 pt-3 bg-white dark:bg-background rounded-xl focus-visible:ring-0 focus-visible:ring-offset-0 border-gray-200 dark:border-border"
        />
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {showAtMention && (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onAtMentionClick}>
                <AtSign className="h-4 w-4" />
              </Button>
            )}
            {showImage && (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onImageClick}>
                <Image className="h-4 w-4" />
              </Button>
            )}
            {showPaperclip && (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onPaperclipClick}>
                <Paperclip className="h-4 w-4" />
              </Button>
            )}
            {showSettings && (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onSettingsClick}>
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </div>
          <Button
            onClick={handleSend}
            disabled={!value.trim()}
            size="sm"
            className="h-8 w-8 p-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
