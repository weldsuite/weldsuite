
import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Building2,
  Calendar,
  DollarSign,
  Percent,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface DealCardProps {
  id: string;
  title: string;
  value: number;
  currency?: string;
  company?: {
    id: string;
    name: string;
    logoUrl?: string;
  };
  contact?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  owner?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  probability?: number;
  expectedCloseDate?: Date;
  lastActivity?: Date;
  tags?: string[];
  isDragging?: boolean;
  onClick?: () => void;
  onCompanyClick?: (companyId: string) => void;
  onContactClick?: (contactId: string) => void;
}

export function DealCard({
  id,
  title,
  value,
  currency = 'USD',
  company,
  contact,
  owner,
  probability,
  expectedCloseDate,
  lastActivity,
  tags = [],
  isDragging = false,
  onClick,
  onCompanyClick,
  onContactClick
}: DealCardProps) {
  const t = useTranslations();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isSortableDragging ? undefined : (transition || 'transform 200ms cubic-bezier(0.18, 0.67, 0.6, 1.22)'),
  };

  const hasDragged = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    hasDragged.current = false;
    startPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const dx = Math.abs(e.clientX - startPos.current.x);
    const dy = Math.abs(e.clientY - startPos.current.y);
    if (dx > 5 || dy > 5) {
      hasDragged.current = true;
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    if (!hasDragged.current && onClick && !isSortableDragging) {
      e.stopPropagation();
      onClick();
    }
  };

  const formatCurrency = (amount: number) => {
    if (amount === 0) return null;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      notation: amount >= 1000000 ? 'compact' : 'standard',
    }).format(amount);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 1);
  };

  const formattedValue = formatCurrency(value);
  const displayOwner = owner || contact;
  const isCompanyClickable = company?.id && onCompanyClick;
  const isContactClickable = (contact?.id || owner?.id) && onContactClick;

  const cardContent = (
    <>
      {/* Title */}
      <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate block">
        {title || t('sweep.weldcrm.dealCard.untitledDeal')}
      </span>

      {/* Company/Record */}
      {company && (
        <div
          className={cn(
            "flex items-center gap-2 mt-2.5",
            isCompanyClickable && "hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer"
          )}
          onClick={(e) => {
            if (isCompanyClickable) {
              e.stopPropagation();
              e.preventDefault();
              onCompanyClick!(company.id);
            }
          }}
          onMouseDown={(e) => isCompanyClickable && e.stopPropagation()}
          onPointerDown={(e) => isCompanyClickable && e.stopPropagation()}
        >
          <Building2 className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className={cn(
            "text-sm text-gray-600 dark:text-muted-foreground truncate",
            isCompanyClickable && "hover:underline underline-offset-2"
          )}>
            {company.name}
          </span>
        </div>
      )}

      {/* Owner/Contact */}
      {displayOwner && (
        <div
          className={cn(
            "flex items-center gap-2 mt-2",
            isContactClickable && "hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer"
          )}
          onClick={(e) => {
            if (isContactClickable) {
              e.stopPropagation();
              e.preventDefault();
              const clickId = contact?.id || owner?.id;
              if (clickId) onContactClick!(clickId);
            }
          }}
          onMouseDown={(e) => isContactClickable && e.stopPropagation()}
          onPointerDown={(e) => isContactClickable && e.stopPropagation()}
        >
          <Avatar className="h-4 w-4 rounded">
            <AvatarImage src={displayOwner.avatarUrl} />
            <AvatarFallback className="text-[9px] bg-cyan-500 text-white rounded">
              {getInitials(displayOwner.name || displayOwner.email || 'U')}
            </AvatarFallback>
          </Avatar>
          <span className={cn(
            "text-sm text-gray-600 dark:text-muted-foreground truncate",
            isContactClickable && "hover:underline underline-offset-2"
          )}>
            {displayOwner.name || displayOwner.email}
          </span>
        </div>
      )}

      {/* Deal Value */}
      <div className="flex items-center gap-2 mt-2">
        <DollarSign className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
        {formattedValue ? (
          <span className="text-sm text-gray-600 dark:text-muted-foreground">{formattedValue}</span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-muted-foreground">{t('sweep.weldcrm.dealCard.noValue')}</span>
        )}
      </div>

      {/* Probability */}
      {probability != null && probability > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <Percent className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-sm text-gray-600 dark:text-muted-foreground">{probability}%</span>
        </div>
      )}

      {/* Close Date */}
      <div className="flex items-center gap-2 mt-2">
        <Calendar className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
        {expectedCloseDate ? (
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {new Date(expectedCloseDate).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-muted-foreground">{t('sweep.weldcrm.dealCard.noDate')}</span>
        )}
      </div>
    </>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      className={cn(
        "group relative bg-white dark:bg-background rounded-lg border border-gray-125 dark:border-border",
        "hover:bg-gray-50 dark:hover:bg-secondary/70 cursor-grab active:cursor-grabbing w-full",
        "p-3 transition-all duration-200",
        isSortableDragging && "!bg-gray-100 dark:!bg-secondary !border-transparent",
        (isDragging || isSortableDragging) && "opacity-50",
        onClick && "cursor-pointer"
      )}
    >
      {isSortableDragging ? (
        <div className="invisible">{cardContent}</div>
      ) : (
        cardContent
      )}
    </div>
  );
}
