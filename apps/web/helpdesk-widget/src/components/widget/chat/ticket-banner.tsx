/**
 * Ticket Banner Component
 * Compact banner shown at the top of a conversation when a ticket has been linked.
 */

import { Ticket, ChevronRight } from 'lucide-react';

interface TicketBannerProps {
  ticketNumber: string;
  ticketSubject: string;
  ticketStatus: string;
  onClick?: () => void;
}

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

export function TicketBanner({ ticketNumber, ticketSubject, ticketStatus, onClick }: TicketBannerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 bg-blue-50 border-b border-blue-100 hover:bg-blue-100 transition-colors text-left cursor-pointer"
    >
      <Ticket className="h-3.5 w-3.5 text-blue-600 shrink-0" />
      <span className="text-xs font-medium text-blue-700 shrink-0">
        #{ticketNumber}
      </span>
      <span className="text-xs text-blue-600 truncate min-w-0">
        {ticketSubject}
      </span>
      <span className="ml-auto text-[10px] font-medium text-blue-500 bg-blue-100 rounded-full px-1.5 py-0.5 shrink-0">
        {statusLabels[ticketStatus] || ticketStatus}
      </span>
      <ChevronRight className="h-3 w-3 text-blue-400 shrink-0" />
    </button>
  );
}
