
import React, { useState, useTransition, useRef, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  Archive,
  Star,
  CheckCircle,
  CheckCheck,
  Ticket,
  X,
  Check,
  User,
  History,
  Mail,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  ArrowRightLeft,
  UserPlus,
  Link2,
  Bug,
  Users,
  Plus,
  Tag,
  UserCircle,
  Radio,
  AlertTriangle,
  Hash,
  CalendarDays,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { WeldAgentInput, type AttachmentPreview } from '@weldsuite/ui/components/weldagent-input';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type {
  TicketMessage,
  TicketTypeConfig,
  ApiTicket,
} from '@/hooks/queries/use-helpdesk-queries';
import { useTicketTypes } from '@/hooks/queries/use-helpdesk-queries';
import { useRouter } from '@/lib/router';
import { Badge } from '@weldsuite/ui/components/badge';
import { CreateTicketDialog } from '../create-ticket-dialog';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  id: string;
  sender: 'agent' | 'customer';
  text: string;
  timestamp: Date;
  isRead: boolean;
}

export interface InternalNote {
  id: string;
  author: string;
  text: string;
  timestamp: Date;
  type: 'note' | 'status_change' | 'assignment' | 'linked';
}

export interface LinkedReport {
  ticketId: string;
  customerName: string;
  customerEmail: string;
  subject: string;
  status: string;
}

// ============================================================================
// Subcomponents
// ============================================================================

interface TicketDetailClientProps {
  ticket: ApiTicket;
}

// --- Customer Chat View ---
function CustomerChatView({
  messages,
  messagesEndRef,
  ticket,
  weldAgentPrompt,
  setWeldAgentPrompt,
  handleWeldAgentSend,
  isPending,
}: {
  messages: ChatMessage[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  ticket: TicketMessage;
  weldAgentPrompt: string;
  setWeldAgentPrompt: (v: string) => void;
  handleWeldAgentSend: () => void;
  isPending: boolean;
}) {
  const { t } = useI18n();
  const tp = t.helpdesk.ticketsPage;
  return (
    <>
      {/* Chat Thread */}
      <div
        className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-background"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(203, 213, 225, 0.3) transparent'
        }}
      >
        <div className="px-6 py-4">
          {/* Ticket Description */}
          <div className="mb-6">
            <div className="rounded-lg border border-transparent hover:border-gray-200 dark:hover:border-border focus-within:border-gray-300 dark:focus-within:border-border transition-colors px-3 py-2.5 -mx-3">
              <textarea
                defaultValue={ticket.bodyText || ticket.preview || ''}
                placeholder={tp.addDescriptionPlaceholder}
                rows={1}
                className="block w-full text-[14px] leading-relaxed text-gray-700 dark:text-foreground/80 bg-transparent border-none outline-none resize-none p-0 m-0 placeholder:text-gray-400 dark:placeholder:text-muted-foreground"
                style={{ fieldSizing: 'content' } as React.CSSProperties}
              />
            </div>
            <div className="h-px bg-gray-200 dark:bg-border mt-3" />
          </div>

          {/* Date Divider */}
          {messages.length > 0 && (
            <div className="flex items-center justify-center mb-6">
              <div className="h-px flex-1 bg-gray-200 dark:bg-accent" />
              <span className="px-3 text-[11px] font-medium text-gray-400 dark:text-muted-foreground uppercase tracking-wider">
                {messages[0]?.timestamp
                  ? format(new Date(messages[0].timestamp), 'EEEE, MMMM d')
                  : format(new Date(), 'EEEE, MMMM d')}
              </span>
              <div className="h-px flex-1 bg-gray-200 dark:bg-accent" />
            </div>
          )}

          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-500">{tp.noMessagesYet}</p>
            </div>
          )}

          {messages.map((message, index, array) => {
            const lines = message.text.split('\n');
            const lastLine = lines[lines.length - 1];
            const shouldPutTimestampBelow = lastLine.length > 60;

            const nextMessage = array[index + 1];
            const isFollowedBySameSender = nextMessage && nextMessage.sender === message.sender;
            const timeDiffInMinutes = nextMessage
              ? Math.abs(new Date(nextMessage.timestamp).getTime() - new Date(message.timestamp).getTime()) / (1000 * 60)
              : Infinity;
            const shouldGroupWithNext = isFollowedBySameSender && timeDiffInMinutes <= 5;
            const marginBottom = shouldGroupWithNext ? "mb-1.5" : "mb-6";

            const prevMessage = array[index - 1];
            const isPrecededBySameSender = prevMessage && prevMessage.sender === message.sender;
            const prevTimeDiffInMinutes = prevMessage
              ? Math.abs(new Date(message.timestamp).getTime() - new Date(prevMessage.timestamp).getTime()) / (1000 * 60)
              : Infinity;
            const isGroupedWithPrev = isPrecededBySameSender && prevTimeDiffInMinutes <= 5;

            let borderRadiusClass = "rounded-2xl";
            if (message.sender === 'agent') {
              if (isGroupedWithPrev && shouldGroupWithNext) {
                borderRadiusClass = "rounded-l-2xl rounded-tr-sm rounded-br-sm";
              } else if (isGroupedWithPrev && !shouldGroupWithNext) {
                borderRadiusClass = "rounded-l-2xl rounded-tr-sm rounded-br-sm";
              } else if (!isGroupedWithPrev && shouldGroupWithNext) {
                borderRadiusClass = "rounded-2xl rounded-br-sm";
              } else {
                borderRadiusClass = "rounded-2xl rounded-br-sm";
              }
            } else {
              if (isGroupedWithPrev && shouldGroupWithNext) {
                borderRadiusClass = "rounded-r-2xl rounded-tl-sm rounded-bl-sm";
              } else if (isGroupedWithPrev && !shouldGroupWithNext) {
                borderRadiusClass = "rounded-r-2xl rounded-tl-sm rounded-bl-sm";
              } else if (!isGroupedWithPrev && shouldGroupWithNext) {
                borderRadiusClass = "rounded-2xl rounded-bl-sm";
              } else {
                borderRadiusClass = "rounded-2xl rounded-bl-sm";
              }
            }

            return (
              <div key={message.id} className={cn(
                "flex gap-2 items-end",
                marginBottom,
                message.sender === 'agent' ? "justify-end" : ""
              )}>
                <div className={cn(
                  "inline-block max-w-[70%]",
                  message.sender === 'agent' ? "ml-auto" : ""
                )}>
                  <div className={cn(
                    "px-4 py-2.5 inline-block",
                    borderRadiusClass,
                    message.sender === 'agent'
                      ? "bg-[#D7E8FE] dark:bg-[#D7E8FE]"
                      : "bg-[#F3F4F6] dark:bg-secondary"
                  )}>
                    <div className={cn(
                      "text-[14px] leading-relaxed whitespace-pre-wrap break-words",
                      message.sender === 'agent'
                        ? "text-gray-900 dark:text-gray-900"
                        : "text-gray-700 dark:text-foreground"
                    )}>
                      {lines.map((line, i) => {
                        const isLastLine = i === lines.length - 1;
                        if (isLastLine && !shouldPutTimestampBelow) {
                          return (
                            <div key={i} className="flex items-end gap-2">
                              <span className="flex-1">{line}</span>
                              <div className="flex items-center gap-1.5 flex-shrink-0 -translate-y-px">
                                <span className={cn(
                                  "text-[11px]",
                                  message.sender === 'agent'
                                    ? "text-gray-700 dark:text-gray-700"
                                    : "text-gray-500 dark:text-muted-foreground"
                                )}>
                                  {format(new Date(message.timestamp), 'h:mm a')}
                                </span>
                                {message.sender === 'agent' && (
                                  <CheckCheck className="w-4 h-4 text-gray-700" />
                                )}
                              </div>
                            </div>
                          );
                        }
                        return <div key={i}>{line || <br />}</div>;
                      })}
                      {shouldPutTimestampBelow && (
                        <div className="flex items-center gap-1.5 justify-end mt-1">
                          <span className={cn(
                            "text-[11px]",
                            message.sender === 'agent'
                              ? "text-gray-700 dark:text-gray-700"
                              : "text-gray-500 dark:text-muted-foreground"
                          )}>
                            {format(new Date(message.timestamp), 'h:mm a')}
                          </span>
                          {message.sender === 'agent' && (
                            <CheckCheck className="w-4 h-4 text-gray-700" />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* WeldAgent Input */}
      <div className="bg-white dark:bg-background/50 flex-shrink-0">
        <div className="p-6">
          {ticket.status === 'closed' ? (
            <div className="flex items-center justify-center py-3 px-4 bg-gray-50 dark:bg-background rounded-lg border border-gray-200 dark:border-border">
              <span className="text-sm text-gray-500 dark:text-muted-foreground">
                This ticket is closed
              </span>
            </div>
          ) : (
            <WeldAgentInput
              value={weldAgentPrompt}
              onChange={setWeldAgentPrompt}
              onSend={handleWeldAgentSend}
              disabled={isPending}
            />
          )}
        </div>
      </div>
    </>
  );
}

// --- Activity Timeline (shared between back-office and tracker) ---
// Attio-style: avatar + "[name] added a note" header with right-aligned timestamp,
// note card below; system events use a small gray icon with inline text.

const authorColors = [
  'bg-orange-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-pink-500',
  'bg-cyan-500',
];

function getAuthorColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return authorColors[Math.abs(hash) % authorColors.length];
}

function getActionLabel(type: InternalNote['type']) {
  switch (type) {
    case 'note': return 'added a note';
    case 'status_change': return '';
    case 'assignment': return '';
    case 'linked': return '';
  }
}

function highlightSystemText(text: string, type: InternalNote['type']): React.ReactNode {
  if (type === 'status_change') {
    // "Status changed from Open to In Progress"
    const statusMatch = text.match(/^(Status changed from )(.+?)( to )(.+)$/);
    if (statusMatch) {
      return <>{statusMatch[1]}<span className="text-foreground font-medium">{statusMatch[2]}</span>{statusMatch[3]}<span className="text-foreground font-medium">{statusMatch[4]}</span></>;
    }
  }
  if (type === 'assignment') {
    // "Assigned to Mark Johnson (Finance)"
    const assignMatch = text.match(/^(Assigned to )(.+?)(\s*\(.+\))$/);
    if (assignMatch) {
      return <>{assignMatch[1]}<span className="text-foreground font-medium">{assignMatch[2]}</span><span className="text-muted-foreground">{assignMatch[3]}</span></>;
    }
    const simpleAssign = text.match(/^(Assigned to )(.+)$/);
    if (simpleAssign) {
      return <>{simpleAssign[1]}<span className="text-foreground font-medium">{simpleAssign[2]}</span></>;
    }
  }
  if (type === 'linked') {
    // Highlight ticket references like #tkt_002
    const parts = text.split(/(#[a-zA-Z0-9_-]+)/g);
    if (parts.length > 1) {
      return <>{parts.map((part, i) =>
        part.startsWith('#') ? <span key={i} className="text-foreground font-medium">{part}</span> : part
      )}</>;
    }
  }
  return text;
}

function groupNotesByMonth(notes: InternalNote[]) {
  const groups: { label: string; year: number; notes: InternalNote[] }[] = [];
  for (const note of notes) {
    const d = new Date(note.timestamp);
    const year = d.getFullYear();
    const monthLabel = format(d, 'MMMM');
    const key = `${year}-${monthLabel}`;
    const last = groups[groups.length - 1];
    if (last && `${last.year}-${last.label}` === key) {
      last.notes.push(note);
    } else {
      groups.push({ label: monthLabel, year, notes: [note] });
    }
  }
  return groups;
}

function ActivityTimeline({ notes }: { notes: InternalNote[] }) {
  const groups = groupNotesByMonth(notes);

  // Group month-groups by year
  const yearGroups: { year: number; months: typeof groups }[] = [];
  for (const g of groups) {
    const last = yearGroups[yearGroups.length - 1];
    if (last && last.year === g.year) {
      last.months.push(g);
    } else {
      yearGroups.push({ year: g.year, months: [g] });
    }
  }

  const currentYear = new Date().getFullYear();

  return (
    <div className="space-y-6">
      {yearGroups.map((yg, ygIndex) => (
        <div key={yg.year}>
          {/* Year header — only show when transitioning to a different year */}
          {(ygIndex > 0 || yg.year !== currentYear) && (
            <p className="text-[13px] text-muted-foreground mb-3">{yg.year}</p>
          )}

          <div className="space-y-5">
            {yg.months.map((mg, mgIndex) => {
              const currentMonth = format(new Date(), 'MMMM');
              const showMonthHeader = yg.year !== currentYear || mg.label !== currentMonth || mgIndex > 0;
              return (
              <div key={`${yg.year}-${mg.label}`}>
                {/* Month header — only show when transitioning to a different month */}
                {showMonthHeader && (
                  <div className="flex items-center gap-0 mb-4">
                    <span className="text-[12px] text-foreground font-medium border border-border rounded-md px-2 py-0.5 bg-background relative z-10">
                      {mg.label}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                )}

                {/* Notes in this month — tree view */}
                <div>
                  {mg.notes.map((note, index) => {
                    const isNote = note.type === 'note';
                    const isLast = index === mg.notes.length - 1;

                    if (isNote) {
                      return (
                        <div key={note.id} className="flex">
                          {/* Tree connector */}
                          <div className="relative flex-shrink-0" style={{ width: 20 }}>
                            <div className={cn(
                              'relative z-10 w-5 h-5 rounded-md flex items-center justify-center text-white text-[9px] font-semibold',
                              getAuthorColor(note.author),
                            )} style={{ marginTop: 0 }}>
                              {note.author.charAt(0).toUpperCase()}
                            </div>
                            {!isLast && (
                              <div className="absolute bg-border" style={{ left: 9, top: 25, bottom: 5, width: 1 }} />
                            )}
                          </div>

                          {/* Content */}
                          <div className={cn("flex-1 min-w-0 pl-2.5", isLast ? "" : "pb-7")}>
                            {/* Header row */}
                            <div className="flex items-baseline gap-1.5 mb-[7px]">
                              <span className="text-[14px] font-medium text-foreground">{note.author}</span>
                              <span className="text-[14px] text-muted-foreground">{getActionLabel(note.type)}</span>
                              <span className="flex-1" />
                              <span className="text-[12px] text-muted-foreground/60 flex-shrink-0">
                                {formatDistanceToNow(new Date(note.timestamp), { addSuffix: true }).replace('about ', '')}
                              </span>
                            </div>
                            {/* Note card */}
                            <div className="rounded-lg border border-border px-3 py-2">
                              <p className="text-[14px] leading-relaxed text-foreground whitespace-pre-wrap">
                                {note.text}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    // System / inline event
                    return (
                      <div key={note.id} className="flex">
                        {/* Tree connector */}
                        <div className="relative flex-shrink-0" style={{ width: 20 }}>
                          <div className="relative z-10 w-5 h-5 rounded-md flex items-center justify-center bg-muted" style={{ marginTop: 3 }}>
                            {note.type === 'status_change' && <ArrowRightLeft className="w-2.5 h-2.5 text-muted-foreground" />}
                            {note.type === 'assignment' && <UserPlus className="w-2.5 h-2.5 text-muted-foreground" />}
                            {note.type === 'linked' && <Link2 className="w-2.5 h-2.5 text-muted-foreground" />}
                          </div>
                          {!isLast && (
                            <div className="absolute bg-border" style={{ left: 9, top: 28, bottom: 5, width: 1 }} />
                          )}
                        </div>

                        {/* Content */}
                        <div className={cn("flex-1 min-w-0 pl-2.5 flex items-start pt-0.5", isLast ? "" : "pb-7")}>
                          <p className="flex-1 text-[14px] text-muted-foreground">
                            {highlightSystemText(note.text, note.type)}
                          </p>
                          <span className="text-[12px] text-muted-foreground/60 flex-shrink-0 ml-3">
                            {formatDistanceToNow(new Date(note.timestamp), { addSuffix: true }).replace('about ', '')}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}


// --- Back-Office View ---
function BackOfficeView({
  notes,
  ticket,
  onAddNote,
}: {
  notes: InternalNote[];
  ticket: TicketMessage;
  onAddNote: (text: string, attachments?: AttachmentPreview[]) => void;
}) {
  const { t } = useI18n();
  const tp = t.helpdesk.ticketsPage;
  const [noteText, setNoteText] = useState('');
  const timelineEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [notes]);

  const handleSubmit = (attachments?: AttachmentPreview[]) => {
    if (!noteText.trim() && (!attachments || attachments.length === 0)) return;
    const text = noteText.trim()
      ? attachments && attachments.length > 0
        ? `${noteText}\n\n📎 ${attachments.map(a => a.name).join(', ')}`
        : noteText
      : `📎 ${attachments!.map(a => a.name).join(', ')}`;
    onAddNote(text);
    setNoteText('');
  };

  return (
    <>
      <div
        className="flex-1 overflow-y-auto min-h-0 bg-background"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(203, 213, 225, 0.3) transparent'
        }}
      >
        <div className="px-4 pt-2.5 pb-5">
          {/* Ticket Description */}
          <div className="mb-6">
            <div className="rounded-lg border border-transparent hover:border-gray-200 dark:hover:border-border focus-within:border-gray-300 dark:focus-within:border-border transition-colors px-3 py-2.5 -mx-3">
              <textarea
                defaultValue={ticket.bodyText || ticket.preview || ''}
                placeholder={tp.addDescriptionPlaceholder}
                rows={1}
                className="block w-full text-[14px] leading-relaxed text-foreground/80 bg-transparent border-none outline-none resize-none p-0 m-0 placeholder:text-muted-foreground"
                style={{ fieldSizing: 'content' } as React.CSSProperties}
              />
            </div>
            <div className="h-px bg-gray-200 dark:bg-border mt-3" />
          </div>

          {notes.length === 0 && !(ticket.bodyText || ticket.preview) && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mb-3">
                <MessageSquare className="h-5 w-5 text-muted-foreground/50" />
              </div>
              <p className="text-sm font-medium text-foreground">{tp.noActivityYet}</p>
              <p className="text-[13px] text-muted-foreground mt-0.5">{tp.addNoteToStart}</p>
            </div>
          )}

          <ActivityTimeline notes={notes} />
          <div ref={timelineEndRef} />
        </div>
      </div>

      {ticket.status !== 'closed' ? (
        <div className="bg-white dark:bg-background/50 flex-shrink-0">
          <div className="p-4">
            <WeldAgentInput
              value={noteText}
              onChange={setNoteText}
              onSend={handleSubmit}
              placeholder={tp.addNotePlaceholder}
              enableAttachments
            />
          </div>
        </div>
      ) : (
        <div className="flex-shrink-0 border-t border-border bg-background">
          <div className="px-5 py-3">
            <div className="flex items-center justify-center py-2.5 px-4 rounded-lg border border-border bg-muted/50">
              <span className="text-[13px] text-muted-foreground">
                {tp.ticketClosedBanner}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- Tracker View ---

const trackerStatusColors: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-600',
  pending: 'bg-blue-500/10 text-blue-600',
  resolved: 'bg-amber-500/10 text-amber-600',
  closed: 'bg-muted text-muted-foreground',
};

function TrackerView({
  notes,
  linkedReports,
  ticket,
  onAddNote,
}: {
  notes: InternalNote[];
  linkedReports: LinkedReport[];
  ticket: TicketMessage;
  onAddNote: (text: string, attachments?: AttachmentPreview[]) => void;
}) {
  const { t } = useI18n();
  const tp = t.helpdesk.ticketsPage;
  const [noteText, setNoteText] = useState('');
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [notes]);

  const handleSubmit = (attachments?: AttachmentPreview[]) => {
    if (!noteText.trim() && (!attachments || attachments.length === 0)) return;
    const text = noteText.trim()
      ? attachments && attachments.length > 0
        ? `${noteText}\n\n📎 ${attachments.map(a => a.name).join(', ')}`
        : noteText
      : `📎 ${attachments!.map(a => a.name).join(', ')}`;
    onAddNote(text);
    setNoteText('');
  };

  return (
    <>
      <div
        className="flex-1 overflow-y-auto min-h-0 bg-background"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(203, 213, 225, 0.3) transparent'
        }}
      >
        <div className="px-4 pt-2.5 pb-5">
          {/* Ticket Description */}
          <div className="mb-6">
            <div className="rounded-lg border border-transparent hover:border-gray-200 dark:hover:border-border focus-within:border-gray-300 dark:focus-within:border-border transition-colors px-3 py-2.5 -mx-3">
              <textarea
                defaultValue={ticket.bodyText || ticket.preview || ''}
                placeholder={tp.addDescriptionPlaceholder}
                rows={1}
                className="block w-full text-[14px] leading-relaxed text-foreground/80 bg-transparent border-none outline-none resize-none p-0 m-0 placeholder:text-muted-foreground"
                style={{ fieldSizing: 'content' } as React.CSSProperties}
              />
            </div>
            <div className="h-px bg-gray-200 dark:bg-border mt-3" />
          </div>

          {/* Linked Reports Section */}
          {linkedReports.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground">{tp.linkedReportsLabel}</span>
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 text-[10px] font-medium rounded-md bg-muted text-muted-foreground border border-border">
                    {linkedReports.length}
                  </span>
                </div>
                <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none">
                  <Plus className="h-3 w-3 mr-1" />
                  {tp.linkButton}
                </Button>
              </div>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {linkedReports.map((report) => (
                  <Button
                    variant="ghost"
                    key={report.ticketId}
                    onClick={() => router.push(`/welddesk/tickets/${report.ticketId}`)}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-muted/50 transition-colors text-left"
                  >
                    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {report.customerName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] text-foreground truncate block">
                        {report.customerName}
                      </span>
                      <span className="text-[11px] text-muted-foreground truncate block">
                        {report.subject}
                      </span>
                    </div>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-md font-medium flex-shrink-0", trackerStatusColors[report.status] || trackerStatusColors.closed)}>
                      {report.status}
                    </span>
                  </Button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/60 mt-2 px-0.5">
                {linkedReports.length !== 1
                  ? tp.customerCountPlural.replace('{count}', String(linkedReports.length))
                  : tp.customerCountSingular.replace('{count}', String(linkedReports.length))}
              </p>
            </div>
          )}

          {/* Activity divider */}
          {linkedReports.length > 0 && notes.length > 0 && (
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">{tp.activityDivider}</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}

          {notes.length === 0 && linkedReports.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center mb-3">
                <Bug className="h-5 w-5 text-muted-foreground/50" />
              </div>
              <p className="text-sm font-medium text-foreground">{tp.noActivityYet}</p>
              <p className="text-[13px] text-muted-foreground mt-0.5">{tp.linkReportsAndTrack}</p>
            </div>
          )}

          <ActivityTimeline notes={notes} />
          <div ref={timelineEndRef} />
        </div>
      </div>

      {ticket.status !== 'closed' ? (
        <div className="bg-white dark:bg-background/50 flex-shrink-0">
          <div className="p-4">
            <WeldAgentInput
              value={noteText}
              onChange={setNoteText}
              onSend={handleSubmit}
              placeholder={tp.addNotePlaceholder}
              enableAttachments
            />
          </div>
        </div>
      ) : (
        <div className="flex-shrink-0 border-t border-border bg-background">
          <div className="px-5 py-3">
            <div className="flex items-center justify-center py-2.5 px-4 rounded-lg border border-border bg-muted/50">
              <span className="text-[13px] text-muted-foreground">
                {tp.ticketIsClosedBanner}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================================
// Sidebar
// ============================================================================

function SidebarSection({
  title,
  icon: Icon,
  defaultExpanded = true,
  children,
}: {
  title: string;
  icon?: React.ElementType;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div>
      <Button
        variant="ghost"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full py-1 group"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="text-[13px] font-medium text-foreground">{title}</span>
      </Button>
      {expanded && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function SidebarFieldRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-[120px] flex-shrink-0 h-8">
        <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-[13px] text-muted-foreground truncate">{label}</span>
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SidebarSelectField({
  defaultValue,
  options,
}: {
  defaultValue: string;
  options: { value: string; label: string }[];
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative -mx-2">
      <Button
        variant="ghost"
        onClick={() => setOpen(!open)}
        className={cn(
          "h-8 w-full text-[13px] text-left rounded-md px-2 border flex items-center justify-between gap-1",
          open
            ? "border-blue-500 dark:border-blue-500 bg-white dark:bg-gray-900"
            : "border-transparent hover:border-gray-200 dark:hover:border-gray-700 bg-transparent",
        )}
      >
        <span className="truncate text-foreground">{selected?.label || value}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      </Button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[140px] w-full bg-popover border border-border rounded-md shadow-md p-1">
          {options.map((opt) => (
            <Button
              variant="ghost"
              key={opt.value}
              onClick={() => { setValue(opt.value); setOpen(false); }}
              className={cn(
                "w-full text-left text-[13px] px-2 py-1.5 rounded-sm",
                opt.value === value
                  ? "bg-accent text-foreground"
                  : "text-foreground hover:bg-accent"
              )}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarInputField({
  defaultValue,
  placeholder,
  className: extraClassName,
}: {
  defaultValue: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="text"
      defaultValue={defaultValue}
      placeholder={placeholder || '--'}
      className={cn(
        "h-8 w-full text-[13px] text-foreground bg-transparent border border-transparent rounded-md px-2 -mx-2 outline-none transition-colors placeholder:text-muted-foreground truncate",
        "hover:border-gray-200 dark:hover:border-gray-700",
        "focus:border-blue-500 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-900",
        extraClassName,
      )}
    />
  );
}

function TicketSidebar({
  ticket,
  ticketType,
  category,
  customFieldEntries,
  ticketTypeFields,
  linkedReports,
  linkedConversations,
  getPriorityColor,
  getStatusColor,
  router,
}: {
  ticket: TicketMessage;
  ticketType: TicketTypeConfig | undefined;
  category: string;
  customFieldEntries: [string, unknown][];
  ticketTypeFields: TicketTypeConfig['fields'];
  linkedReports: LinkedReport[];
  linkedConversations: { id: string; subject: string; status: string; customerName: string }[];
  getPriorityColor: (p?: TicketMessage['priority']) => string;
  getStatusColor: (s?: string) => string;
  router: ReturnType<typeof useRouter>;
}) {
  const { t } = useI18n();
  const tp = t.helpdesk.ticketsPage;
  const { fields: visFields, fieldVisibility, isFieldVisible, toggleField, resetToDefaults } = useDrawerFieldVisibility('ticket-sidebar');

  return (
    <div className="w-[484px] bg-background border-l border-border flex flex-col h-full">
      {/* Panel Header */}
      <div className="px-4 h-[53px] flex items-center border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-7 h-7 rounded-lg flex items-center justify-center text-white font-semibold text-[11px] flex-shrink-0",
            getPriorityColor(ticket.priority)
          )}>
            {(ticket.from || ticket.fromEmail || '?').charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {category === 'back-office' ? (ticket.from || tp.internalTask) : category === 'tracker' ? (ticket.from || tp.trackerTask) : (ticket.from || tp.noCustomer)}
            </h3>
            <p className="text-[12px] text-muted-foreground truncate">
              {category === 'back-office' ? tp.backOfficeTask : category === 'tracker' ? tp.issueTracker : (ticket.fromEmail || tp.noEmail)}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {ticket.fromEmail && category === 'customer' && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push(`/welddesk/tickets?customerEmail=${encodeURIComponent(ticket.fromEmail)}`)}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                title={tp.viewAllTickets}
              >
                <History className="h-4 w-4" />
              </Button>
            )}
            {category === 'customer' && (
              <Button variant="ghost" size="icon" className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors" title={tp.sendEmail}>
                <Mail className="h-4 w-4" />
              </Button>
            )}
            <DrawerFieldSettings
              fields={visFields}
              fieldVisibility={fieldVisibility}
              onToggle={toggleField}
              onReset={resetToDefaults}
            />
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(156, 163, 175, 0.2) transparent' }}>
        <div className="p-4 space-y-5">

          {/* Ticket Details */}
          <SidebarSection title={tp.sidebarDetails}>
            <div className="space-y-0.5">
              {isFieldVisible('status') && <SidebarFieldRow icon={Radio} label={tp.fieldStatus}>
                <SidebarSelectField
                  defaultValue={ticket.status || 'open'}
                  options={[
                    { value: 'open', label: tp.statusOpen },
                    { value: 'pending', label: tp.statusInProgress },
                    { value: 'resolved', label: tp.statusResolved },
                    { value: 'closed', label: tp.statusClosed },
                  ]}
                />
              </SidebarFieldRow>}
              {isFieldVisible('priority') && <SidebarFieldRow icon={AlertTriangle} label={tp.fieldPriority}>
                <SidebarSelectField
                  defaultValue={ticket.priority || 'normal'}
                  options={[
                    { value: 'low', label: tp.priorityLow },
                    { value: 'normal', label: tp.priorityNormal },
                    { value: 'high', label: tp.priorityHigh },
                    { value: 'urgent', label: tp.priorityUrgent },
                  ]}
                />
              </SidebarFieldRow>}
              {isFieldVisible('assignee') && <SidebarFieldRow icon={UserCircle} label={tp.fieldAssignee}>
                <SidebarSelectField
                  defaultValue={ticket.assignee || 'unassigned'}
                  options={[
                    ...(ticket.assignee ? [{ value: ticket.assignee, label: ticket.assignee }] : []),
                    { value: 'unassigned', label: tp.valueUnassigned },
                  ]}
                />
              </SidebarFieldRow>}
              {isFieldVisible('type') && <SidebarFieldRow icon={Hash} label={tp.fieldType}>
                {ticketType ? (
                  <span className="text-[13px] text-foreground h-8 flex items-center px-2 -mx-2">
                    {ticketType.name}
                  </span>
                ) : (
                  <span className="text-[13px] text-muted-foreground h-8 flex items-center px-2 -mx-2">--</span>
                )}
              </SidebarFieldRow>}
              {isFieldVisible('channel') && category === 'customer' && (
                <SidebarFieldRow icon={MessageSquare} label={tp.fieldChannel}>
                  <SidebarSelectField
                    defaultValue={ticket.channel || 'email'}
                    options={[
                      { value: 'email', label: tp.channelEmail },
                      { value: 'chat', label: tp.channelChat },
                      { value: 'phone', label: tp.channelPhone },
                      { value: 'social', label: tp.channelSocial },
                    ]}
                  />
                </SidebarFieldRow>
              )}
              {isFieldVisible('created') && <SidebarFieldRow icon={CalendarDays} label={tp.fieldCreated}>
                <span className="text-[13px] text-foreground h-8 flex items-center px-2 -mx-2">
                  {format(new Date(ticket.date || new Date()), 'MMM d, h:mm a')}
                </span>
              </SidebarFieldRow>}
            </div>
          </SidebarSection>

          {/* Custom Fields */}
          {customFieldEntries.length > 0 && (
            <SidebarSection title={ticketType ? ticketType.name : tp.customFieldsLabel}>
              <div className="space-y-0.5">
                {customFieldEntries.map(([key, value]) => {
                  const fieldDef = ticketTypeFields.find((f) => f.key === key);
                  const label = fieldDef?.label || key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
                  let displayValue: string;
                  if (Array.isArray(value)) {
                    displayValue = value.join(', ');
                  } else if (typeof value === 'boolean') {
                    displayValue = value ? tp.valueYes : tp.valueNo;
                  } else {
                    displayValue = String(value || '');
                  }

                  // For select fields, show a select; for text/number, show an input
                  if (fieldDef?.type === 'select' && fieldDef.options) {
                    return (
                      <SidebarFieldRow key={key} icon={Tag} label={label}>
                        <SidebarSelectField
                          defaultValue={displayValue}
                          options={fieldDef.options.map((o) => ({ value: o.value, label: o.label }))}
                        />
                      </SidebarFieldRow>
                    );
                  }

                  return (
                    <SidebarFieldRow key={key} icon={Tag} label={label}>
                      <SidebarInputField defaultValue={displayValue} />
                    </SidebarFieldRow>
                  );
                })}
              </div>
            </SidebarSection>
          )}

          {/* Customer (customer category) */}
          {isFieldVisible('customer') && category === 'customer' && (
            <SidebarSection title={tp.sidebarCustomer}>
              <div className="space-y-0.5">
                <SidebarFieldRow icon={User} label={tp.fieldName}>
                  <SidebarInputField defaultValue={ticket.from || ''} placeholder={tp.notSpecified} />
                </SidebarFieldRow>
                <SidebarFieldRow icon={Mail} label={tp.fieldEmail}>
                  <SidebarInputField
                    defaultValue={ticket.fromEmail || ''}
                    placeholder={tp.notSpecified}
                    className={ticket.fromEmail ? 'text-blue-600 dark:text-blue-400' : ''}
                  />
                </SidebarFieldRow>
              </div>
            </SidebarSection>
          )}

          {/* Tags */}
          {isFieldVisible('tags') && <SidebarSection title={tp.sidebarTags} defaultExpanded={!!(ticket.labels && ticket.labels.length > 0)}>
            <div className="px-2 -mx-2">
              {ticket.labels && ticket.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {ticket.labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 bg-accent text-muted-foreground rounded-md group"
                    >
                      {label}
                      <Button variant="ghost" className="opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity">
                        <X className="h-3 w-3" />
                      </Button>
                    </span>
                  ))}
                </div>
              ) : (
                <Button variant="ghost" className="text-[13px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                  <Plus className="h-3 w-3" />
                  {tp.addTag}
                </Button>
              )}
            </div>
          </SidebarSection>}

          {/* Linked Conversations */}
          {isFieldVisible('linkedConversations') && linkedConversations.length > 0 && (
            <SidebarSection title={tp.sidebarLinkedConversations}>
              <div className="space-y-1.5">
                {linkedConversations.map((conv) => (
                  <Button
                    variant="ghost"
                    key={conv.id}
                    onClick={() => router.push(`/welddesk/inbox/all/${conv.id}`)}
                    className="w-full flex items-center gap-2.5 px-2 py-2 -mx-2 rounded-md hover:bg-accent transition-colors text-left"
                  >
                    <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center flex-shrink-0">
                      <MessageSquare className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] text-foreground truncate block">{conv.subject}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">{conv.customerName}</span>
                        <span className={cn("text-[10px] px-1.5 py-px rounded font-medium", getStatusColor(conv.status))}>
                          {conv.status}
                        </span>
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            </SidebarSection>
          )}

          {/* Impact (tracker) */}
          {isFieldVisible('linkedReports') && category === 'tracker' && (
            <SidebarSection title={tp.sidebarImpact}>
              <div className="space-y-0.5">
                <SidebarFieldRow icon={Users} label={tp.fieldAffected}>
                  <span className="text-[13px] font-medium text-foreground h-8 flex items-center px-2 -mx-2">
                    {linkedReports.length !== 1
                      ? tp.customerCountPlural.replace('{count}', String(linkedReports.length))
                      : tp.customerCountSingular.replace('{count}', String(linkedReports.length))}
                  </span>
                </SidebarFieldRow>
                <SidebarFieldRow icon={Link2} label={tp.fieldLinkedTickets}>
                  <span className="text-[13px] font-medium text-foreground h-8 flex items-center px-2 -mx-2">
                    {linkedReports.length}
                  </span>
                </SidebarFieldRow>
              </div>
              {linkedReports.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {linkedReports.slice(0, 3).map((report) => (
                    <Button
                      variant="ghost"
                      key={report.ticketId}
                      onClick={() => router.push(`/welddesk/tickets/${report.ticketId}`)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md hover:bg-accent transition-colors text-left"
                    >
                      <div className="w-5 h-5 rounded-md bg-accent flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {report.customerName.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <span className="text-[12px] text-muted-foreground truncate flex-1">{report.customerName}</span>
                      <span className={cn("text-[10px] px-1.5 py-px rounded font-medium flex-shrink-0", trackerStatusColors[report.status] || trackerStatusColors.closed)}>
                        {report.status}
                      </span>
                    </Button>
                  ))}
                  {linkedReports.length > 3 && (
                    <p className="text-[11px] text-muted-foreground text-center py-1">
                      {tp.andMoreItems.replace('{count}', String(linkedReports.length - 3))}
                    </p>
                  )}
                </div>
              )}
            </SidebarSection>
          )}

          {/* Internal Notes (customer view) */}
          {category === 'customer' && (
            <SidebarSection title={tp.sidebarInternalNotes}>
              <Textarea
                placeholder={tp.addNotePlaceholder}
                className="text-[13px] min-h-[60px] border-transparent bg-transparent shadow-none hover:border-gray-200 dark:hover:border-gray-700 focus-visible:ring-0 focus-visible:border-blue-500 dark:focus-visible:border-blue-500 focus-visible:bg-white dark:focus-visible:bg-gray-900 px-2 -mx-2 rounded-md placeholder:text-muted-foreground"
                rows={3}
              />
            </SidebarSection>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function TicketDetailClient({
  ticket: apiTicket,
}: TicketDetailClientProps) {
  const { t } = useI18n();
  const tp = t.helpdesk.ticketsPage;
  const router = useRouter();
  const { data: ticketTypes } = useTicketTypes();

  // Map ApiTicket to the internal TicketMessage shape for subcomponents
  const ticketMessage: TicketMessage = {
    id: apiTicket.id,
    ticketId: apiTicket.id,
    from: apiTicket.customerName || '',
    fromEmail: apiTicket.customerEmail || '',
    to: [],
    cc: [],
    subject: apiTicket.subject,
    preview: apiTicket.description || '',
    bodyText: apiTicket.description || '',
    date: new Date(apiTicket.createdAt),
    isRead: true,
    isStarred: false,
    labels: apiTicket.tags || [],
    hasAttachments: false,
    channel: (apiTicket.channel as TicketMessage['channel']) || 'email',
    priority: apiTicket.priority as TicketMessage['priority'],
    status: apiTicket.status as TicketMessage['status'],
    assignee: apiTicket.assigneeName || apiTicket.assigneeId,
    ticketTypeId: apiTicket.ticketTypeId,
    customFields: apiTicket.customFields,
  };

  const [ticket, setTicket] = useState(ticketMessage);

  const ticketType = (ticketTypes || []).find((t: TicketTypeConfig) => t.id === ticket.ticketTypeId);
  const category = ticketType?.category || 'customer';
  const customFieldEntries = Object.entries(ticket.customFields || {});
  const ticketTypeFields = ticketType?.fields || [];

  const linkedReports: LinkedReport[] = [];
  const linkedConversations = (apiTicket.linkedConversations || []).map((conv) => ({
    id: conv.id,
    subject: conv.subject || tp.untitledConversation,
    status: conv.status || 'active',
    customerName: conv.customerName || conv.customerEmail || tp.unknownCustomer,
  }));

  useBreadcrumbs([
    { label: tp.helpdeskBreadcrumb, href: '/welddesk' },
    { label: tp.ticketsBreadcrumb, href: '/welddesk/tickets' },
    { label: apiTicket.subject || tp.ticketDetailTitle },
  ]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [weldAgentPrompt, setWeldAgentPrompt] = useState('');
  const [isPending] = useTransition();
  const [showCreateTicket, setShowCreateTicket] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isEditingSubject, setIsEditingSubject] = useState(false);
  const [, setEditedSubject] = useState(ticket.subject || '');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleWeldAgentSend = async () => {
    if (!weldAgentPrompt.trim()) return;

    const messageContent = weldAgentPrompt;
    setWeldAgentPrompt('');

    const newMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'agent',
      text: messageContent,
      timestamp: new Date(),
      isRead: false,
    };

    setMessages(prev => [...prev, newMessage]);
    toast.success(t.helpdesk.ticketsPage.messageSent);
  };

  const handleAddNote = (text: string) => {
    const newNote: InternalNote = {
      id: `note-${Date.now()}`,
      author: tp.authorYou,
      text,
      timestamp: new Date(),
      type: 'note',
    };
    setNotes(prev => [...prev, newNote]);
    toast.success(t.helpdesk.ticketsPage.noteAdded);
  };

  const handleArchive = () => {
    toast.success(t.helpdesk.ticketsPage.ticketArchived);
    router.push('/welddesk/tickets');
  };

  const handleDeleteConfirm = () => {
    setShowDeleteDialog(false);
    toast.success(t.helpdesk.ticketsPage.ticketDeleted);
    router.push('/welddesk/tickets');
  };

  const handleClose = () => {
    setTicket(prev => ({ ...prev, status: 'closed' }));
    toast.success(t.helpdesk.ticketsPage.ticketClosed);
  };

  const handleToggleStar = () => {
    setTicket(prev => ({ ...prev, isStarred: !prev.isStarred }));
  };

  const getPriorityColor = (priority?: TicketMessage['priority']) => {
    switch (priority) {
      case 'urgent':
        return 'bg-red-500 text-white';
      case 'high':
        return 'bg-orange-500 text-white';
      case 'normal':
        return 'bg-blue-500 text-white';
      case 'low':
        return 'bg-gray-500 text-white';
      default:
        return 'bg-gray-500 text-white';
    }
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'open':
        return 'bg-green-100 text-green-700';
      case 'pending':
        return 'bg-blue-100 text-blue-700';
      case 'resolved':
        return 'bg-yellow-100 text-yellow-700';
      case 'closed':
        return 'bg-gray-100 text-gray-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <>
    <div className="bg-white dark:bg-background/30 flex h-full overflow-hidden flex-1">
      {/* Main Content Area */}
      <div className="flex flex-col h-full flex-1">
        {/* Closed Banner */}
        {ticket.status === 'closed' && (
          <div className="px-6 py-2 bg-gray-100 dark:bg-secondary border-b border-gray-200 dark:border-border flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-gray-500" />
            <span className="text-sm text-gray-600 dark:text-muted-foreground">
              {tp.ticketClosedBanner}
            </span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Mobile back button */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors flex-shrink-0"
              onClick={() => router.push('/welddesk/tickets')}
              aria-label={tp.backToTickets}
            >
              <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
            </Button>
            {/* Desktop close/done buttons */}
            <div className="hidden md:flex items-center border border-border rounded-md overflow-hidden flex-shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
                onClick={() => router.push('/welddesk/tickets')}
                title={tp.backToTickets}
              >
                <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
              </Button>
              <div className="w-px h-5 bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
                onClick={() => {
                  handleClose();
                  router.push('/welddesk/tickets');
                }}
                disabled={isPending || ticket.status === 'closed'}
                title={ticket.status === 'closed' ? tp.alreadyClosed : tp.closeAndGoBack}
              >
                <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
              </Button>
            </div>
            {isEditingSubject ? (
              <input
                ref={subjectInputRef}
                type="text"
                defaultValue={ticket.subject || ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setTicket(prev => ({ ...prev, subject: subjectInputRef.current?.value || '' }));
                    setIsEditingSubject(false);
                  } else if (e.key === 'Escape') {
                    setIsEditingSubject(false);
                  }
                }}
                onBlur={() => {
                  setTicket(prev => ({ ...prev, subject: subjectInputRef.current?.value || '' }));
                  setIsEditingSubject(false);
                }}
                className="text-sm md:text-lg font-medium text-gray-900 dark:text-foreground bg-transparent outline-none border border-blue-500 dark:border-blue-400 rounded-md px-2 py-0.5 min-w-[80px] w-full -ml-0.5"
                autoFocus
              />
            ) : (
              <div
                className="flex items-center min-w-0 group cursor-text border border-transparent hover:border-gray-300 dark:hover:border-border rounded-md px-2 py-0.5 -ml-0.5 transition-colors"
                onClick={() => {
                  setEditedSubject(ticket.subject || '');
                  setIsEditingSubject(true);
                }}
              >
                <h1 className="text-sm md:text-lg font-medium text-gray-900 dark:text-foreground truncate">
                  {ticket.subject || tp.noSubject}
                </h1>
              </div>
            )}
            {/* Category badge */}
            {category === 'back-office' && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-medium border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 flex-shrink-0">
                {tp.labelInternal}
              </Badge>
            )}
            {category === 'tracker' && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-medium border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 flex-shrink-0">
                {tp.labelTracker}
              </Badge>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
            {category === 'tracker' && linkedReports.length > 0 && (
              <span className="text-[11px] text-red-600 dark:text-red-400 font-medium bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded-md mr-1">
                {tp.affectedCount.replace('{count}', String(linkedReports.length))}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleToggleStar}
              className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", ticket.isStarred && "text-yellow-500")}
              title={ticket.isStarred ? tp.unstar : tp.star}
            >
              <Star className={cn("h-4 w-4", ticket.isStarred ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleArchive}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
              title={tp.archive}
            >
              <Archive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowCreateTicket(true)}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
              title={tp.createTicketLabel}
            >
              <Ticket className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
            </Button>
          </div>
        </div>

        {/* Category-specific main content */}
        {category === 'customer' && (
          <CustomerChatView
            messages={messages}
            messagesEndRef={messagesEndRef}
            ticket={ticket}
            weldAgentPrompt={weldAgentPrompt}
            setWeldAgentPrompt={setWeldAgentPrompt}
            handleWeldAgentSend={handleWeldAgentSend}
            isPending={isPending}
          />
        )}
        {category === 'back-office' && (
          <BackOfficeView
            notes={notes}
            ticket={ticket}
            onAddNote={handleAddNote}
          />
        )}
        {category === 'tracker' && (
          <TrackerView
            notes={notes}
            linkedReports={linkedReports}
            ticket={ticket}
            onAddNote={handleAddNote}
          />
        )}
      </div>

      {/* Ticket Details Panel */}
      <TicketSidebar
        ticket={ticket}
        ticketType={ticketType}
        category={category}
        customFieldEntries={customFieldEntries}
        ticketTypeFields={ticketTypeFields}
        linkedReports={linkedReports}
        linkedConversations={linkedConversations}
        getPriorityColor={getPriorityColor}
        getStatusColor={getStatusColor}
        router={router}
      />
    </div>

    {/* Create Ticket Dialog */}
    <CreateTicketDialog
      open={showCreateTicket}
      onOpenChange={setShowCreateTicket}
      prefillData={{
        subject: ticket.subject,
        customerEmail: ticket.fromEmail,
        customerName: ticket.from,
        description: ticket.bodyText,
      }}
    />

    {/* Delete Confirmation Dialog */}
    <ConfirmDialog
      open={showDeleteDialog}
      onOpenChange={setShowDeleteDialog}
      title={tp.deleteTicketTitle}
      description={tp.deleteTicketDescription}
      confirmLabel={tp.deleteConfirm}
      variant="destructive"
      onConfirm={handleDeleteConfirm}
    />
    </>
  );
}
