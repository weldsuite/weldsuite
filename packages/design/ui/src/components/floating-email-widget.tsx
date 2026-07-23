'use client';

import { useRef, useState, useEffect } from 'react';
import { 
  X, 
  Maximize2, 
  Send,
  Bold,
  Italic,
  Underline,
  Link2,
  Image as ImageIcon,
  Smile,
  Variable,
  Clock,
  ChevronLeft
} from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { cn } from '../lib/utils';
import { usePinnedEmail } from '../contexts/pinned-email-context';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './dialog';

export function FloatingEmailWidget() {
  const { isPinned, emailData, unpinEmail, updateEmailData } = usePinnedEmail();
  const [isMaximized, setIsMaximized] = useState(false);
  const emailBodyRef = useRef<HTMLDivElement>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showVariableMenu, setShowVariableMenu] = useState(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.emoji-picker-container') && !target.closest('.variable-picker-container')) {
        setShowEmojiPicker(false);
        setShowVariableMenu(false);
      }
    };

    if (showEmojiPicker || showVariableMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showEmojiPicker, showVariableMenu]);

  if (!isPinned || !emailData) return null;

  const applyFormatting = (command: string, value?: string) => {
    if (emailBodyRef.current) {
      emailBodyRef.current.focus();
      document.execCommand(command, false, value);
      updateEmailData({ body: emailBodyRef.current.innerHTML });
      emailBodyRef.current.focus();
    }
  };

  const handleInsertVariable = (variable: string) => {
    if (emailBodyRef.current) {
      emailBodyRef.current.focus();
      document.execCommand('insertText', false, variable);
      updateEmailData({ body: emailBodyRef.current.innerHTML });
      emailBodyRef.current.focus();
    }
    setShowVariableMenu(false);
  };

  const handleInsertEmoji = (emoji: string) => {
    if (emailBodyRef.current) {
      emailBodyRef.current.focus();
      document.execCommand('insertText', false, emoji);
      updateEmailData({ body: emailBodyRef.current.innerHTML });
      emailBodyRef.current.focus();
    }
    setShowEmojiPicker(false);
  };

  const handleSend = async () => {
    setIsSending(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    toast.success('Email sent successfully!');
    setIsSending(false);
    unpinEmail();
  };

  const handleScheduleSend = () => {
    if (scheduleDate && scheduleTime) {
      toast.success(`Email scheduled for ${scheduleDate} at ${scheduleTime}`);
      setShowScheduleDialog(false);
      unpinEmail();
    }
  };

  if (isMaximized) {
    return (
      <>
        <Dialog open={isMaximized} onOpenChange={setIsMaximized}>
          <DialogContent 
            className="sm:max-w-none !max-w-[900px] w-[90vw] h-[750px] flex flex-col p-0 gap-0 overflow-hidden bg-white dark:bg-background" 
            showCloseButton={false}
          >
            {/* Compose Header */}
            <div className="flex items-center gap-2 px-5 py-2 border-b flex-shrink-0">
              <span className="text-sm font-medium">
                Compose email
              </span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsMaximized(false)}
                className="h-8 w-8 hover:bg-gray-100 dark:hover:bg-secondary"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={unpinEmail}
                className="h-8 w-8 hover:bg-gray-100 dark:hover:bg-secondary"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            {/* Email Form */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* From Field */}
              <div className="flex items-center px-5 py-2">
                <label className="text-sm text-gray-500 w-12">From</label>
                <div className="inline-flex items-center gap-1 border border-gray-300 rounded-md px-1 py-0.5 bg-gray-50 ml-3">
                  <div className="h-4 w-4 rounded bg-purple-500 flex items-center justify-center text-white text-[9px] font-medium">
                    A
                  </div>
                  <span className="text-sm text-gray-700">Alex Smith</span>
                </div>
              </div>
              
              {/* To Field */}
              <div className="flex items-center px-5 py-3">
                <label className="text-sm text-gray-500 w-12">To</label>
                <div className="flex-1 flex items-center justify-between ml-3">
                  <Input
                    value={emailData.to}
                    onChange={(e) => updateEmailData({ to: e.target.value })}
                    placeholder="Recipients"
                    className="flex-1 h-auto py-0 border-0 shadow-none focus-visible:ring-0 px-0 text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-gray-500 hover:text-gray-700 h-6 px-2"
                    onClick={() => updateEmailData({ showCc: !emailData.showCc })}
                  >
                    Add CC / BCC
                  </Button>
                </div>
              </div>
              
              {/* CC Field */}
              {emailData.showCc && (
                <div className="flex items-center px-5 py-3 border-b">
                  <label className="text-sm text-gray-500 w-12">Cc</label>
                  <Input
                    value={emailData.cc}
                    onChange={(e) => updateEmailData({ cc: e.target.value })}
                    placeholder=""
                    className="flex-1 h-auto py-0 border-0 shadow-none focus-visible:ring-0 px-0 ml-3 text-sm"
                  />
                </div>
              )}
              
              {/* BCC Field */}
              {emailData.showBcc && (
                <div className="flex items-center px-5 py-3 border-b">
                  <label className="text-sm text-gray-500 w-12">Bcc</label>
                  <Input
                    value={emailData.bcc}
                    onChange={(e) => updateEmailData({ bcc: e.target.value })}
                    placeholder=""
                    className="flex-1 h-auto py-0 border-0 shadow-none focus-visible:ring-0 px-0 ml-3 text-sm"
                  />
                </div>
              )}
              
              {/* Subject Field */}
              <div className="flex items-center px-5 py-3 border-b">
                <label className="text-sm text-gray-500 w-12">Subject</label>
                <Input
                  value={emailData.subject}
                  onChange={(e) => updateEmailData({ subject: e.target.value })}
                  placeholder="Enter subject..."
                  className="flex-1 h-auto py-0 border-0 shadow-none focus-visible:ring-0 px-0 ml-3 text-sm"
                />
              </div>
              
              {/* Email Body */}
              <div className="flex-1 overflow-auto px-5 py-4">
                <div
                  ref={emailBodyRef}
                  contentEditable
                  className="min-h-[300px] focus:outline-none text-sm"
                  dangerouslySetInnerHTML={{ __html: emailData.body }}
                  onInput={(e) => updateEmailData({ body: e.currentTarget.innerHTML })}
                  style={{ whiteSpace: 'pre-wrap' }}
                />
              </div>
              
              {/* Formatting Toolbar */}
              <div className="px-5 py-3 border-t bg-gray-50 dark:bg-background flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <div className="relative variable-picker-container">
                    <button
                      type="button"
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                      onClick={() => setShowVariableMenu(!showVariableMenu)}
                      title="Insert Variable"
                    >
                      <Variable className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                    </button>
                    {showVariableMenu && (
                      <div className="absolute bottom-10 left-0 z-50 bg-white dark:bg-background border border-gray-200 dark:border-border rounded-lg shadow-xl py-1 min-w-[160px]">
                        {[
                          { name: 'First name', value: '{{firstName}}' },
                          { name: 'Last name', value: '{{lastName}}' },
                          { name: 'Email', value: '{{email}}' },
                          { name: 'Company', value: '{{company}}' }
                        ].map((variable) => (
                          <button
                            key={variable.value}
                            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-secondary text-sm"
                            onClick={() => handleInsertVariable(variable.value)}
                            type="button"
                          >
                            {variable.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="w-px h-5 bg-gray-300 dark:bg-accent mx-1" />
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyFormatting('bold');
                    }}
                    title="Bold"
                  >
                    <Bold className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyFormatting('italic');
                    }}
                    title="Italic"
                  >
                    <Italic className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyFormatting('underline');
                    }}
                    title="Underline"
                  >
                    <Underline className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const url = prompt('Enter the link URL:');
                      if (url) applyFormatting('createLink', url);
                    }}
                    title="Insert Link"
                  >
                    <Link2 className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const url = prompt('Enter image URL:');
                      if (url) applyFormatting('insertImage', url);
                    }}
                    title="Insert Image"
                  >
                    <ImageIcon className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                    onClick={() => setShowScheduleDialog(true)}
                    title="Schedule Send"
                  >
                    <Clock className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                  </button>
                  <div className="w-px h-5 bg-gray-300 dark:bg-accent mx-1" />
                  <div className="relative emoji-picker-container">
                    <button
                      type="button"
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      title="Insert Emoji"
                    >
                      <Smile className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                    </button>
                    {showEmojiPicker && (
                      <div className="absolute bottom-12 left-0 z-50 bg-white dark:bg-background border border-gray-200 dark:border-border rounded-lg shadow-xl p-3 min-w-[320px]">
                        <div className="grid grid-cols-8 gap-2">
                          {['😊', '😄', '😍', '🎉', '👍', '❤️', '🔥', '✨', '🚀', '💯', '👏', '🙌', '🤝', '✅', '📧', '📅'].map((emoji) => (
                            <button
                              key={emoji}
                              className="w-9 h-9 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors text-xl"
                              onClick={() => handleInsertEmoji(emoji)}
                              type="button"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-border">
                          <div className="text-xs text-gray-500 dark:text-muted-foreground mb-2">Frequently used</div>
                          <div className="grid grid-cols-8 gap-2">
                            {['👋', '🙏', '💪', '🎯', '📈', '💡', '📝', '📌', '⭐', '🔔', '💬', '📊', '🎨', '🛠️', '🔗', '📎'].map((emoji) => (
                              <button
                                key={emoji}
                                className="w-9 h-9 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors text-xl"
                                onClick={() => handleInsertEmoji(emoji)}
                                type="button"
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                
                <Button
                  onClick={handleSend}
                  disabled={isSending || !emailData.to || !emailData.subject}
                  className="h-9 px-4 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {isSending ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Sending...
                    </>
                  ) : (
                    "Send"
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Schedule Send Dialog */}
        <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Schedule Email</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <label htmlFor="schedule-date" className="text-sm font-medium">
                  Date
                </label>
                <Input
                  id="schedule-date"
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>
              <div className="grid gap-2">
                <label htmlFor="schedule-time" className="text-sm font-medium">
                  Time
                </label>
                <Input
                  id="schedule-time"
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowScheduleDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleScheduleSend}>
                Schedule Send
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Minimized floating widget
  return (
    <div className="fixed bottom-4 right-4 w-96 bg-white dark:bg-background rounded-lg shadow-2xl border border-gray-200 dark:border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-background border-b">
        <span className="text-sm font-medium">Compose email</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setIsMaximized(true)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={unpinEmail}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <div className="p-3 space-y-2">
        <div className="space-y-1">
          <Input
            value={emailData.to}
            onChange={(e) => updateEmailData({ to: e.target.value })}
            placeholder="To"
            className="text-sm h-8"
          />
          <Input
            value={emailData.subject}
            onChange={(e) => updateEmailData({ subject: e.target.value })}
            placeholder="Enter subject..."
            className="text-sm h-8"
          />
        </div>
        
        <div
          ref={emailBodyRef}
          contentEditable
          className="min-h-[100px] max-h-[150px] overflow-y-auto p-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          dangerouslySetInnerHTML={{ __html: emailData.body }}
          onInput={(e) => updateEmailData({ body: e.currentTarget.innerHTML })}
        />
        
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onMouseDown={(e) => {
                e.preventDefault();
                applyFormatting('bold');
              }}
            >
              <Bold className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onMouseDown={(e) => {
                e.preventDefault();
                applyFormatting('italic');
              }}
            >
              <Italic className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onMouseDown={(e) => {
                e.preventDefault();
                applyFormatting('underline');
              }}
            >
              <Underline className="h-3 w-3" />
            </Button>
          </div>
          <Button 
            size="sm" 
            onClick={handleSend}
            disabled={isSending || !emailData.to || !emailData.subject}
            className="h-7 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isSending ? (
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <>
                <Send className="h-3 w-3 mr-1" />
                Send
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}