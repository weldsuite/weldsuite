
import { useState, useRef, useEffect, ReactNode, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Share2,
  Link2,
  Maximize2,
  MoreHorizontal,
  X,
  Check,
  Plus,
  ChevronDown,
  Copy,
  Trash2,
  Archive,
  Star,
} from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { CommentInput } from '@weldsuite/ui/components/comment-input';

export interface Comment {
  id: string;
  author: {
    name: string;
    initials: string;
    avatar?: string;
    color?: string;
  };
  content: string;
  createdAt: Date;
}

export interface EntityOwner {
  name: string;
  initials: string;
  avatar?: string;
  color: string;
}

export interface EntityField {
  label: string;
  value: ReactNode;
}

export interface SubItem {
  id: string;
  title: string;
  isCompleted?: boolean;
}

export interface ActivityItem {
  id: string;
  author: EntityOwner;
  action: string;
  timestamp: string;
}

export interface EntityDetailPanelProps {
  // Core
  isOpen: boolean;
  onClose: () => void;
  title: string;
  onTitleChange?: (value: string) => void;
  description?: string;

  // Header
  isCompleted?: boolean;
  onToggleComplete?: () => void;
  completeButtonLabel?: string;
  completedButtonLabel?: string;
  showHeaderActions?: boolean;
  onShare?: () => void;
  onCopyLink?: () => void;
  onMaximize?: () => void;
  onDuplicate?: () => void;
  onAddToFavorites?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onMoreOptions?: () => void;
  headerActions?: ReactNode;

  // Content
  visibilityText?: string;
  fields?: EntityField[];
  descriptionValue?: string;
  onDescriptionChange?: (value: string) => void;
  descriptionPlaceholder?: string;
  descriptionLabel?: string;

  // Sub-items (e.g., subtasks, sub-goals)
  subItems?: SubItem[];
  subItemsLabel?: string;
  onAddSubItem?: () => void;
  onToggleSubItem?: (id: string) => void;
  onRemoveSubItem?: (id: string) => void;
  onSubItemClick?: (id: string) => void;

  // Comments
  comments?: Comment[];
  commentInput?: string;
  onCommentInputChange?: (value: string) => void;
  onSendComment?: () => void;
  commentPlaceholder?: string;

  // Activity
  activities?: ActivityItem[];

  // Styling
  width?: string;
  topOffset?: string;
  className?: string;

  // Children for custom content
  children?: ReactNode;
  customFooter?: ReactNode;
}

export function EntityDetailPanel({
  isOpen,
  onClose,
  title,
  onTitleChange,
  description,
  isCompleted = false,
  onToggleComplete,
  completeButtonLabel = 'Mark complete',
  completedButtonLabel = 'Completed',
  showHeaderActions = true,
  onShare,
  onCopyLink,
  onMaximize,
  onDuplicate,
  onAddToFavorites,
  onArchive,
  onDelete,
  headerActions,
  visibilityText = 'This item is visible to everyone.',
  fields = [],
  descriptionValue,
  onDescriptionChange,
  descriptionPlaceholder = 'Add a description...',
  descriptionLabel = 'Description',
  subItems = [],
  subItemsLabel = 'Subtasks',
  onAddSubItem,
  onToggleSubItem,
  onRemoveSubItem,
  onSubItemClick,
  comments = [],
  commentInput = '',
  onCommentInputChange,
  onSendComment,
  commentPlaceholder = 'Add a comment...',
  activities = [],
  width = '620px',
  topOffset = '205px',
  className,
  children,
  customFooter,
}: EntityDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<'comments' | 'activity'>('comments');
  const [commentsHeight, setCommentsHeight] = useState(250);
  const [showCommentInput, setShowCommentInput] = useState(true);
  const [localDescription, setLocalDescription] = useState(descriptionValue || '');
  const isResizingRef = useRef(false);
  const commentsHeightRef = useRef(commentsHeight);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevTitleRef = useRef(title);

  // Only sync local description when switching to a different entity (title changes)
  useEffect(() => {
    if (prevTitleRef.current !== title) {
      setLocalDescription(descriptionValue || '');
      prevTitleRef.current = title;
    }
  }, [title, descriptionValue]);

  // Close WeldAgent when this panel opens
  useEffect(() => {
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('close-weldagent'));
    }
  }, [isOpen]);

  // Close this panel when WeldAgent opens
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  // Debounced description change handler
  const handleDescriptionChange = useCallback((value: string) => {
    setLocalDescription(value);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      onDescriptionChange?.(value);
    }, 500); // 500ms debounce
  }, [onDescriptionChange]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    commentsHeightRef.current = commentsHeight;
  }, [commentsHeight]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    const startHeight = commentsHeightRef.current;
    isResizingRef.current = true;

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.min(Math.max(startHeight + deltaY, 100), 800);
      setCommentsHeight(newHeight);
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      upEvent.preventDefault();
      upEvent.stopPropagation();
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 md:hidden"
        onClick={onClose}
      />
      {/* Desktop size constraints */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media (min-width: 768px) {
          .entity-detail-panel-responsive {
            width: ${width} !important;
            top: ${topOffset} !important;
            height: calc(100vh - ${topOffset}) !important;
            left: auto !important;
            bottom: auto !important;
          }
        }
      `}} />
      {/* Panel - responsive: full screen on mobile, side panel on desktop */}
      <div
        className={cn(
          "entity-detail-panel-responsive fixed bg-white dark:bg-background z-50 flex flex-col",
          // Mobile: full screen
          "inset-0",
          // Desktop: side panel
          "md:inset-auto md:right-0 md:border-l",
          className
        )}
      >
      {/* Scrollable Content Area */}
      <div
        className="[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        <div className="p-4">
          {/* Title */}
          <div className="mb-4">
            <div className="flex items-center gap-3 mb-1">
              {onToggleComplete && (
                <button
                  className={cn(
                    "h-5 w-5 rounded-[6px] border-[1.5px] flex items-center justify-center flex-shrink-0 transition-colors",
                    isCompleted
                      ? "bg-green-500 border-green-500 text-white"
                      : "border-gray-300 hover:border-gray-400"
                  )}
                  onClick={onToggleComplete}
                >
                  {isCompleted && <Check className="h-3 w-3" />}
                </button>
              )}
              {onTitleChange ? (
                <input
                  type="text"
                  value={title}
                  onChange={(e) => onTitleChange(e.target.value)}
                  className="text-xl font-semibold text-gray-900 dark:text-foreground w-full bg-transparent border-0 outline-none focus:ring-0 p-0 flex-1"
                  placeholder="Task name"
                />
              ) : (
                <h2 className="text-xl font-semibold text-gray-900 dark:text-foreground flex-1">{title}</h2>
              )}
              <div className="flex items-center gap-1 flex-shrink-0">
                {showHeaderActions && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      {onShare && (
                        <DropdownMenuItem onClick={onShare}>
                          <Share2 className="h-4 w-4 mr-2" />
                          Share
                        </DropdownMenuItem>
                      )}
                      {onCopyLink && (
                        <DropdownMenuItem onClick={onCopyLink}>
                          <Link2 className="h-4 w-4 mr-2" />
                          Copy link
                        </DropdownMenuItem>
                      )}
                      {onDuplicate && (
                        <DropdownMenuItem onClick={onDuplicate}>
                          <Copy className="h-4 w-4 mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                      )}
                      {onAddToFavorites && (
                        <DropdownMenuItem onClick={onAddToFavorites}>
                          <Star className="h-4 w-4 mr-2" />
                          Add to favorites
                        </DropdownMenuItem>
                      )}
                      {onArchive && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={onArchive}>
                            <Archive className="h-4 w-4 mr-2" />
                            Archive
                          </DropdownMenuItem>
                        </>
                      )}
                      {onDelete && (
                        <DropdownMenuItem onClick={onDelete} className="text-red-600 focus:text-red-600">
                          <Trash2 className="h-4 w-4 mr-2 text-red-600" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {visibilityText && (
              <p className="text-sm text-gray-500">{visibilityText}</p>
            )}
          </div>

          {/* Fields */}
          {fields.length > 0 && (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {fields.map((field, index) => (
                <div key={index} className="flex items-center justify-between py-3">
                  <span className="text-sm text-gray-500 dark:text-muted-foreground">{field.label}</span>
                  <div className="text-sm">{field.value}</div>
                </div>
              ))}

              {/* Description */}
              {onDescriptionChange && (
                <div className="py-3">
                  <span className="text-sm text-gray-500 dark:text-muted-foreground block mb-2">{descriptionLabel}</span>
                  <Textarea
                    className="w-full min-h-[180px] resize-none text-sm border-0 p-0 focus-visible:ring-0 placeholder:text-gray-400"
                    placeholder={descriptionPlaceholder}
                    value={localDescription}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Sub-items */}
          {(subItems.length > 0 || onAddSubItem) && (
            <div className="mt-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-gray-500 dark:text-muted-foreground">
                  {subItemsLabel} {subItems.length > 0 && `(${subItems.length})`}
                </span>
                {onAddSubItem && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={onAddSubItem}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                )}
              </div>

              {subItems.length > 0 ? (
                <div className="space-y-1">
                  {subItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-secondary rounded-md group"
                    >
                      {onToggleSubItem && (
                        <button
                          className={cn(
                            "w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors",
                            item.isCompleted
                              ? "bg-green-500 border-green-500 text-white"
                              : "border-gray-300 dark:border-border hover:border-gray-400"
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleSubItem(item.id);
                          }}
                        >
                          {item.isCompleted && <Check className="h-3 w-3" />}
                        </button>
                      )}
                      <span
                        className={cn(
                          "text-sm flex-1",
                          onSubItemClick && "cursor-pointer",
                          item.isCompleted && "line-through text-gray-400"
                        )}
                        onClick={() => onSubItemClick?.(item.id)}
                      >
                        {item.title}
                      </span>
                      {onRemoveSubItem && (
                        <button
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 dark:hover:bg-accent rounded transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveSubItem(item.id);
                          }}
                        >
                          <X className="h-3 w-3 text-gray-400" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 dark:border-border rounded-md">
                  No {subItemsLabel.toLowerCase()} yet
                </div>
              )}
            </div>
          )}

          {/* Custom children content */}
          {children}
        </div>
      </div>

      {/* Comments Section - Fixed at bottom */}
      {(comments.length > 0 || onSendComment || activities.length > 0) && (
        <div className="bg-white dark:bg-background" style={{ flexShrink: 0 }}>
          {/* Draggable resize handle */}
          <div
            className="h-3 cursor-ns-resize flex items-center justify-center group"
            onMouseDown={handleResizeStart}
          >
            <div className="w-full h-px bg-gray-200 dark:bg-secondary group-hover:bg-gray-300 dark:group-hover:bg-gray-700 transition-colors" />
          </div>

          <div className="flex items-center justify-between px-4 pt-[7px] pb-3 border-b">
            <div className="flex items-center gap-2">
              <Button
                variant={activeTab === 'comments' ? 'default' : 'outline'}
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveTab('comments');
                }}
              >
                Comments
              </Button>
              <Button
                variant={activeTab === 'activity' ? 'default' : 'outline'}
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveTab('activity');
                }}
              >
                All activity
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                setShowCommentInput(!showCommentInput);
              }}
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  !showCommentInput && "rotate-180"
                )}
              />
            </Button>
          </div>

          {/* Comments Tab Content */}
          {showCommentInput && activeTab === 'comments' && (
            <div>
              {/* Comments List */}
              {comments.length > 0 && (
                <div
                  className="px-4 py-3 space-y-3 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300"
                  style={{ maxHeight: `${commentsHeight}px` }}
                >
                  {comments.map((comment) => (
                    <div key={comment.id} className="flex gap-2">
                      <div
                        className="h-5 w-5 rounded-sm flex items-center justify-center text-[9px] font-semibold text-white flex-shrink-0"
                        style={{ backgroundColor: comment.author.color || '#1f2937' }}
                      >
                        {comment.author.initials}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{comment.author.name}</span>
                          <span className="text-xs text-gray-500">
                            {comment.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 dark:text-muted-foreground mt-1">
                          {comment.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Comment Input */}
              {onSendComment && onCommentInputChange && (
                <CommentInput
                  value={commentInput}
                  onChange={onCommentInputChange}
                  onSend={onSendComment}
                  placeholder={commentPlaceholder}
                />
              )}
            </div>
          )}

          {/* All Activity Tab Content */}
          {showCommentInput && activeTab === 'activity' && (
            <div
              className="px-4 py-3 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-gray-300"
              style={{ maxHeight: `${commentsHeight}px` }}
            >
              <div className="space-y-3">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex gap-2 items-center">
                    <div
                      className="h-5 w-5 rounded-sm flex items-center justify-center text-[9px] font-semibold text-white flex-shrink-0"
                      style={{ backgroundColor: activity.author.color }}
                    >
                      {activity.author.initials}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-foreground">
                        <span className="font-semibold">{activity.author.name}</span>{' '}
                        <span className="text-muted-foreground">{activity.action} · {activity.timestamp}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Custom Footer */}
      {customFooter}
      </div>
    </>
  );
}
