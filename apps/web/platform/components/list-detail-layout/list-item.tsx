
import React, { ReactNode } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

interface ListItemProps {
  /** Unique identifier */
  id: string;
  /** Whether this item is selected */
  isSelected?: boolean;
  /** Whether this item is unread */
  isUnread?: boolean;
  /** Whether this item is starred */
  isStarred?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Star toggle handler */
  onToggleStar?: (e: React.MouseEvent) => void;
  /** Show star button */
  showStar?: boolean;
  /** Avatar/icon element */
  avatar?: ReactNode;
  /** Primary text (e.g., name, email) */
  primary: string;
  /** Secondary text (e.g., subject) */
  secondary?: string;
  /** Tertiary text (e.g., preview) */
  tertiary?: string;
  /** Timestamp to display */
  timestamp?: string;
  /** Tags/labels to display */
  tags?: string[];
  /** Maximum tags to show before "+X more" */
  maxTags?: number;
  /** Additional className */
  className?: string;
  /** Show border bottom */
  showBorder?: boolean;
}

function ListItem({
  id,
  isSelected = false,
  isUnread = false,
  isStarred = false,
  onClick,
  onToggleStar,
  showStar = true,
  avatar,
  primary,
  secondary,
  tertiary,
  timestamp,
  tags,
  maxTags = 3,
  className,
  showBorder = true,
}: ListItemProps) {
  return (
    <div className={cn("relative", showBorder && "border-b border-gray-200 dark:border-border", className)}>
      <div
        className={cn(
          "group cursor-pointer border border-transparent relative z-0 py-3",
          isSelected
            ? "bg-accent !border-accent border-l-transparent pl-4 -mr-1 pr-4"
            : "hover:bg-gray-50 dark:hover:bg-background/50 pl-4 -mr-3 pr-6"
        )}
        onClick={onClick}
      >
        <div className="flex items-center gap-3">
          {/* Avatar with Unread Indicator Dot */}
          <div className="relative flex-shrink-0" style={{ marginTop: '-22px' }}>
            {/* Blue dot to the left of avatar */}
            {isUnread && !isSelected && (
              <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-600 z-50" />
            )}
            {avatar}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div
                    className={cn(
                      "text-sm truncate flex-1",
                      isUnread ? "font-semibold text-gray-900 dark:text-foreground" : "font-normal text-gray-500 dark:text-muted-foreground"
                    )}
                  >
                    {primary}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                    {showStar && onToggleStar && (
                      <Button
                        variant="ghost"
                        onClick={onToggleStar}
                        className={cn(
                          "p-1 rounded hover:bg-gray-200 dark:hover:bg-secondary transition-colors",
                          isStarred ? "text-yellow-500" : "text-gray-400 opacity-0 group-hover:opacity-100"
                        )}
                      >
                        <Star className={cn("h-4 w-4", isStarred && "fill-current")} />
                      </Button>
                    )}
                    {timestamp && (
                      <span
                        className={cn(
                          "text-xs text-right",
                          isUnread ? "text-gray-900 dark:text-foreground font-semibold" : "font-normal text-gray-500 dark:text-muted-foreground"
                        )}
                      >
                        {timestamp}
                      </span>
                    )}
                  </div>
                </div>
                {secondary && (
                  <div
                    className={cn(
                      "text-sm mt-0.5 truncate",
                      isUnread ? "font-bold text-gray-900 dark:text-foreground" : "font-normal text-gray-500 dark:text-muted-foreground"
                    )}
                  >
                    {secondary}
                  </div>
                )}
                {tertiary && (
                  <div
                    className={cn(
                      "text-sm mt-0.5 line-clamp-1",
                      "text-gray-500 dark:text-muted-foreground"
                    )}
                  >
                    {tertiary}
                  </div>
                )}

                {/* Tags */}
                {tags && tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {tags.slice(0, maxTags).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800"
                      >
                        {tag}
                      </span>
                    ))}
                    {tags.length > maxTags && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-50 text-gray-600 dark:bg-secondary dark:text-muted-foreground">
                        +{tags.length - maxTags}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ListItemAvatarProps {
  /** Text to display (usually first letter) */
  text: string;
  /** Background color class */
  colorClass?: string;
  /** Additional className */
  className?: string;
}

function ListItemAvatar({
  text,
  colorClass = 'bg-gray-500',
  className,
}: ListItemAvatarProps) {
  return (
    <div
      className={cn(
        "w-8 h-8 rounded-md flex items-center justify-center text-white font-semibold text-xs",
        colorClass,
        className
      )}
    >
      {text.charAt(0).toUpperCase()}
    </div>
  );
}
