import { useState, useEffect } from 'react';
import { X, ChevronLeft, Ticket, ChevronRight, Plus, Check, Clock, Mail, Bell } from 'lucide-react';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';
import { platformApi } from '@/lib/api/client';

interface TicketItem {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  priority: string;
  ticketTypeName?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TicketTypeField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  helpText?: string;
  order: number;
  isDefault?: boolean;
  customerVisible?: boolean;
}

interface TicketTypeStateGroup {
  groupKey: 'submitted' | 'in_progress' | 'waiting_on_customer' | 'resolved';
  groupLabel: string;
  customerGroupLabel: string;
  states: { key: string; label: string; customerLabel: string }[];
}

interface TicketDetail {
  id: string;
  ticketNumber: string;
  subject: string;
  description?: string;
  status: string;
  priority: string;
  ticketTypeId?: string;
  ticketTypeName?: string | null;
  ticketTypeStates?: TicketTypeStateGroup[] | null;
  ticketTypeFields?: TicketTypeField[] | null;
  customFields?: Record<string, any>;
  customerEmail?: string;
  customerName?: string;
  assigneeName?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TicketStatusViewProps {
  onClose: () => void;
  onBack?: () => void;
  onCreateTicket?: () => void;
  customerEmail?: string;
  widgetId: string;
  /** If set, opens directly to this ticket's detail view */
  initialTicketId?: string;
}

const DEFAULT_STATE_GROUPS: TicketTypeStateGroup[] = [
  {
    groupKey: 'submitted',
    groupLabel: 'Submitted',
    customerGroupLabel: 'Submitted',
    states: [{ key: 'open', label: 'Open', customerLabel: 'Submitted' }, { key: 'new', label: 'New', customerLabel: 'Submitted' }],
  },
  {
    groupKey: 'in_progress',
    groupLabel: 'In Progress',
    customerGroupLabel: 'In progress',
    states: [{ key: 'in_progress', label: 'In Progress', customerLabel: 'In progress' }, { key: 'pending', label: 'Pending', customerLabel: 'In progress' }],
  },
  {
    groupKey: 'resolved',
    groupLabel: 'Resolved',
    customerGroupLabel: 'Resolved',
    states: [{ key: 'resolved', label: 'Resolved', customerLabel: 'Resolved' }, { key: 'closed', label: 'Closed', customerLabel: 'Resolved' }],
  },
];

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getActiveGroupIndex(stateGroups: TicketTypeStateGroup[], status: string): number {
  for (let i = 0; i < stateGroups.length; i++) {
    if (stateGroups[i].states.some((s) => s.key === status)) {
      return i;
    }
  }
  // Default: first group
  return 0;
}

function getFieldDisplayValue(field: TicketTypeField, value: any): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (field.type === 'select' && field.options) {
    const opt = field.options.find((o) => o.value === value);
    return opt ? opt.label : String(value);
  }
  if (field.type === 'multiselect' && Array.isArray(value) && field.options) {
    return value
      .map((v: string) => {
        const opt = field.options!.find((o) => o.value === v);
        return opt ? opt.label : v;
      })
      .join(', ');
  }
  if (field.type === 'checkbox') return value ? 'Yes' : 'No';
  return String(value);
}

// ============================================================================
// Progress Stepper Component
// ============================================================================

function ProgressStepper({
  stateGroups,
  currentStatus,
}: {
  stateGroups: TicketTypeStateGroup[];
  currentStatus: string;
}) {
  const activeIndex = getActiveGroupIndex(stateGroups, currentStatus);

  return (
    <div style={{ padding: '0' }}>
      {/* Dots and bars */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
        {stateGroups.map((group, i) => {
          const isCompleted = i < activeIndex;
          const isActive = i === activeIndex;
          const isFuture = i > activeIndex;

          return (
            <div key={group.groupKey} style={{ display: 'flex', alignItems: 'center', flex: i < stateGroups.length - 1 ? 1 : undefined }}>
              {/* Dot */}
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  backgroundColor: isCompleted ? '#16a34a' : isActive ? '#3b82f6' : '#e5e7eb',
                  transition: 'background-color 0.3s',
                }}
              >
                {isCompleted ? (
                  <Check size={14} style={{ color: '#ffffff' }} />
                ) : isActive ? (
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#ffffff' }} />
                ) : (
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#9ca3af' }} />
                )}
              </div>

              {/* Connecting bar */}
              {i < stateGroups.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: '3px',
                    backgroundColor: isCompleted ? '#16a34a' : '#e5e7eb',
                    marginLeft: '4px',
                    marginRight: '4px',
                    borderRadius: '2px',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {isActive && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        height: '100%',
                        width: '50%',
                        backgroundColor: '#3b82f6',
                        borderRadius: '2px',
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {stateGroups.map((group, i) => {
          const isCompleted = i < activeIndex;
          const isActive = i === activeIndex;

          return (
            <span
              key={group.groupKey}
              style={{
                fontSize: '11px',
                fontWeight: isActive ? 600 : 400,
                color: isCompleted ? '#16a34a' : isActive ? '#3b82f6' : '#9ca3af',
                textAlign: i === 0 ? 'left' : i === stateGroups.length - 1 ? 'right' : 'center',
                flex: 1,
              }}
            >
              {group.customerGroupLabel}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Ticket Detail View (Intercom-style)
// ============================================================================

function TicketDetailView({
  ticketId,
  widgetId,
  onBack,
  onClose,
  isMobile,
  containerHeight,
}: {
  ticketId: string;
  widgetId: string;
  onBack: () => void;
  onClose: () => void;
  isMobile: boolean;
  containerHeight: string;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const apiUrl = (platformApi as any).apiUrl || import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
        const response = await fetch(`${apiUrl}/api/tickets/${ticketId}`, {
          headers: { 'x-widget-id': widgetId },
        });
        const result = await response.json();
        if (result.success && result.data) {
          setDetail(result.data);
        }
      } catch (err) {
        console.error('[Widget] Failed to fetch ticket detail:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [ticketId, widgetId]);

  if (loading) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div
          style={{
            width: '32px',
            height: '32px',
            border: '3px solid #e5e7eb',
            borderTopColor: '#6b7280',
            borderRadius: '50%',
            margin: '0 auto 12px',
            animation: 'spin 1s linear infinite',
          }}
        />
        <p style={{ fontSize: '14px', color: '#6b7280' }}>Loading...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <p style={{ fontSize: '14px', color: '#6b7280' }}>Could not load ticket details.</p>
      </div>
    );
  }

  const stateGroups = detail.ticketTypeStates && detail.ticketTypeStates.length > 0
    ? detail.ticketTypeStates
    : DEFAULT_STATE_GROUPS;

  const visibleFields = (detail.ticketTypeFields || [])
    .filter((f) => f.customerVisible !== false && !f.isDefault)
    .sort((a, b) => a.order - b.order);

  const customFieldEntries = visibleFields
    .map((field) => {
      const value = detail.customFields?.[field.key];
      const displayValue = getFieldDisplayValue(field, value);
      return displayValue ? { label: field.label, value: displayValue } : null;
    })
    .filter(Boolean) as { label: string; value: string }[];

  return (
    <>
      {/* Header */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #f3f4f6',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            color: '#6b7280',
          }}
        >
          <ChevronLeft size={20} />
        </button>
        <span style={{ flex: 1, fontSize: '16px', fontWeight: 600, color: '#111827' }}>
          {detail.ticketTypeName || detail.subject}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            color: '#6b7280',
          }}
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          ...subtleScrollbarStyles,
        }}
      >
        <div style={{ padding: '24px 20px' }}>
          {/* Subject */}
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#111827', marginBottom: '20px' }}>
            {detail.subject}
          </h3>

          {/* Assignee section */}
          {detail.assigneeName && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '24px',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  backgroundColor: '#eff6ff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#3b82f6' }}>
                  {getInitials(detail.assigneeName)}
                </span>
              </div>
              <span style={{ fontSize: '14px', color: '#374151' }}>
                <strong>{detail.assigneeName}</strong> will pick this up soon
              </span>
            </div>
          )}

          {/* Progress Stepper */}
          <div
            style={{
              backgroundColor: '#f9fafb',
              borderRadius: '12px',
              padding: '16px',
              marginBottom: '20px',
            }}
          >
            <ProgressStepper stateGroups={stateGroups} currentStatus={detail.status} />
          </div>

          {/* Timestamp */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '16px',
            }}
          >
            <Clock size={14} style={{ color: '#9ca3af' }} />
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>
              {formatRelativeTime(detail.createdAt)}
            </span>
          </div>

          {/* Notification info */}
          {detail.customerEmail && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px',
                backgroundColor: '#f0f9ff',
                borderRadius: '10px',
                marginBottom: '16px',
              }}
            >
              <Bell size={16} style={{ color: '#3b82f6', flexShrink: 0, marginTop: '1px' }} />
              <div>
                <p style={{ fontSize: '13px', color: '#374151', margin: 0 }}>
                  You will be notified here and by email
                </p>
                <p style={{ fontSize: '12px', color: '#6b7280', margin: '2px 0 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Mail size={12} />
                  {detail.customerEmail}
                </p>
              </div>
            </div>
          )}

          {/* Ticket ID */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              backgroundColor: '#f3f4f6',
              borderRadius: '6px',
              marginBottom: '20px',
            }}
          >
            <Ticket size={13} style={{ color: '#6b7280' }} />
            <span style={{ fontSize: '12px', color: '#6b7280', fontWeight: 500 }}>
              Ticket ID #{detail.ticketNumber}
            </span>
          </div>

          {/* Custom fields summary */}
          {customFieldEntries.length > 0 && (
            <div
              style={{
                borderTop: '1px solid #f3f4f6',
                paddingTop: '16px',
              }}
            >
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
                Details
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {customFieldEntries.map((entry) => (
                  <div key={entry.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '13px', color: '#6b7280' }}>{entry.label}</span>
                    <span style={{ fontSize: '13px', color: '#111827', fontWeight: 500, textAlign: 'right', maxWidth: '60%' }}>
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Exported: Ticket Detail Inline (for use in ticket-create-view success state)
// ============================================================================

export function TicketDetailInline({
  ticketId,
  widgetId,
  onDone,
}: {
  ticketId: string;
  widgetId: string;
  onDone: () => void;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const apiUrl = (platformApi as any).apiUrl || import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
        const response = await fetch(`${apiUrl}/api/tickets/${ticketId}`, {
          headers: { 'x-widget-id': widgetId },
        });
        const result = await response.json();
        if (result.success && result.data) {
          setDetail(result.data);
        }
      } catch (err) {
        console.error('[Widget] Failed to fetch ticket detail:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [ticketId, widgetId]);

  if (loading) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div
          style={{
            width: '32px',
            height: '32px',
            border: '3px solid #e5e7eb',
            borderTopColor: '#6b7280',
            borderRadius: '50%',
            margin: '0 auto 12px',
            animation: 'spin 1s linear infinite',
          }}
        />
        <p style={{ fontSize: '14px', color: '#6b7280' }}>Loading your request...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center' }}>
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            backgroundColor: '#dcfce7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <Check size={24} style={{ color: '#16a34a' }} />
        </div>
        <p style={{ fontSize: '16px', fontWeight: 600, color: '#111827', marginBottom: '4px' }}>Request Submitted</p>
        <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '20px' }}>We'll get back to you soon.</p>
        <button
          onClick={onDone}
          style={{
            padding: '10px 24px',
            fontSize: '14px',
            fontWeight: 500,
            color: '#ffffff',
            backgroundColor: '#3b82f6',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
    );
  }

  const stateGroups = detail.ticketTypeStates && detail.ticketTypeStates.length > 0
    ? detail.ticketTypeStates
    : DEFAULT_STATE_GROUPS;

  const visibleFields = (detail.ticketTypeFields || [])
    .filter((f) => f.customerVisible !== false && !f.isDefault)
    .sort((a, b) => a.order - b.order);

  const customFieldEntries = visibleFields
    .map((field) => {
      const value = detail.customFields?.[field.key];
      const displayValue = getFieldDisplayValue(field, value);
      return displayValue ? { label: field.label, value: displayValue } : null;
    })
    .filter(Boolean) as { label: string; value: string }[];

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', ...subtleScrollbarStyles }}>
        <div style={{ padding: '24px 20px' }}>
          {/* Success header */}
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                backgroundColor: '#dcfce7',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
              }}
            >
              <Check size={24} style={{ color: '#16a34a' }} />
            </div>
            <p style={{ fontSize: '16px', fontWeight: 600, color: '#111827', margin: '0 0 2px 0' }}>
              Request Submitted
            </p>
            <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>{detail.subject}</p>
          </div>

          {/* Assignee section */}
          {detail.assigneeName && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '24px',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  backgroundColor: '#eff6ff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#3b82f6' }}>
                  {getInitials(detail.assigneeName)}
                </span>
              </div>
              <span style={{ fontSize: '14px', color: '#374151' }}>
                <strong>{detail.assigneeName}</strong> will pick this up soon
              </span>
            </div>
          )}

          {/* Progress Stepper */}
          <div
            style={{
              backgroundColor: '#f9fafb',
              borderRadius: '12px',
              padding: '16px',
              marginBottom: '20px',
            }}
          >
            <ProgressStepper stateGroups={stateGroups} currentStatus={detail.status} />
          </div>

          {/* Timestamp */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '16px' }}>
            <Clock size={14} style={{ color: '#9ca3af' }} />
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>
              {formatRelativeTime(detail.createdAt)}
            </span>
          </div>

          {/* Notification info */}
          {detail.customerEmail && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px',
                backgroundColor: '#f0f9ff',
                borderRadius: '10px',
                marginBottom: '16px',
              }}
            >
              <Bell size={16} style={{ color: '#3b82f6', flexShrink: 0, marginTop: '1px' }} />
              <div>
                <p style={{ fontSize: '13px', color: '#374151', margin: 0 }}>
                  You will be notified here and by email
                </p>
                <p style={{ fontSize: '12px', color: '#6b7280', margin: '2px 0 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Mail size={12} />
                  {detail.customerEmail}
                </p>
              </div>
            </div>
          )}

          {/* Ticket ID */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              backgroundColor: '#f3f4f6',
              borderRadius: '6px',
              marginBottom: '20px',
            }}
          >
            <Ticket size={13} style={{ color: '#6b7280' }} />
            <span style={{ fontSize: '12px', color: '#6b7280', fontWeight: 500 }}>
              Ticket ID #{detail.ticketNumber}
            </span>
          </div>

          {/* Custom fields summary */}
          {customFieldEntries.length > 0 && (
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: '16px' }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
                Details
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {customFieldEntries.map((entry) => (
                  <div key={entry.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '13px', color: '#6b7280' }}>{entry.label}</span>
                    <span style={{ fontSize: '13px', color: '#111827', fontWeight: 500, textAlign: 'right', maxWidth: '60%' }}>
                      {entry.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Done button */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #f3f4f6', flexShrink: 0 }}>
        <button
          onClick={onDone}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '14px',
            fontWeight: 500,
            color: '#ffffff',
            backgroundColor: '#3b82f6',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
    </>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function TicketStatusView({
  onClose,
  onBack,
  onCreateTicket,
  customerEmail,
  widgetId,
  initialTicketId,
}: TicketStatusViewProps) {
  const isMobile = useMobileDetection();
  const viewportHeight = useViewportHeight();
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(initialTicketId || null);

  useEffect(() => {
    if (!customerEmail) {
      setLoading(false);
      return;
    }

    const fetchTickets = async () => {
      try {
        const apiUrl = (platformApi as any).apiUrl || import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
        const response = await fetch(`${apiUrl}/api/tickets?customerEmail=${encodeURIComponent(customerEmail)}`, {
          headers: { 'x-widget-id': widgetId },
        });
        const result = await response.json();
        if (result.success && result.data) {
          setTickets(result.data);
        }
      } catch (err) {
        console.error('[Widget] Failed to fetch tickets:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTickets();
  }, [customerEmail, widgetId]);

  const containerHeight = isMobile
    ? `${viewportHeight}px`
    : 'min(680px, 88vh)';

  return (
    <div
      className="widget-view"
      style={{
        position: isMobile ? 'fixed' : 'absolute',
        bottom: isMobile ? 0 : '80px',
        right: isMobile ? 0 : '20px',
        width: isMobile ? '100%' : '400px',
        height: containerHeight,
        maxHeight: isMobile ? '100dvh' : 'min(680px, 88vh)',
        borderRadius: isMobile ? 0 : '16px',
        overflow: 'hidden',
        backgroundColor: '#ffffff',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 999999,
      }}
    >
      <style>{subtleScrollbarCSS}</style>

      {selectedTicketId ? (
        /* Ticket Detail (Intercom-style) */
        <TicketDetailView
          ticketId={selectedTicketId}
          widgetId={widgetId}
          onBack={() => {
            if (initialTicketId && selectedTicketId === initialTicketId && onBack) {
              onBack();
            } else {
              setSelectedTicketId(null);
            }
          }}
          onClose={onClose}
          isMobile={isMobile}
          containerHeight={containerHeight}
        />
      ) : (
        <>
          {/* Header */}
          <div
            style={{
              padding: '16px 20px',
              borderBottom: '1px solid #f3f4f6',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexShrink: 0,
            }}
          >
            {onBack && (
              <button
                onClick={onBack}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  color: '#6b7280',
                }}
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Ticket size={18} style={{ color: '#6b7280' }} />
              <span style={{ fontSize: '16px', fontWeight: 600, color: '#111827' }}>
                Your Requests
              </span>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                color: '#6b7280',
              }}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              ...subtleScrollbarStyles,
            }}
          >
            {loading ? (
              /* Loading */
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    border: '3px solid #e5e7eb',
                    borderTopColor: '#6b7280',
                    borderRadius: '50%',
                    margin: '0 auto 12px',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                <p style={{ fontSize: '14px', color: '#6b7280' }}>Loading your requests...</p>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            ) : !customerEmail ? (
              /* No email */
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <Ticket size={40} style={{ color: '#d1d5db', margin: '0 auto 12px' }} />
                <p style={{ fontSize: '14px', color: '#6b7280' }}>
                  Please provide your email to view your requests.
                </p>
              </div>
            ) : tickets.length === 0 ? (
              /* Empty */
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <Ticket size={40} style={{ color: '#d1d5db', margin: '0 auto 12px' }} />
                <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '16px' }}>
                  No requests found.
                </p>
                {onCreateTicket && (
                  <button
                    onClick={onCreateTicket}
                    style={{
                      padding: '8px 16px',
                      fontSize: '14px',
                      fontWeight: 500,
                      color: '#ffffff',
                      backgroundColor: '#3b82f6',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: 'pointer',
                    }}
                  >
                    Submit a Request
                  </button>
                )}
              </div>
            ) : (
              /* Ticket List */
              <div style={{ padding: '8px 12px' }}>
                {tickets.map((ticket) => (
                  <button
                    key={ticket.id}
                    onClick={() => setSelectedTicketId(ticket.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      border: 'none',
                      borderRadius: '10px',
                      backgroundColor: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background-color 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f9fafb')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ticket.subject}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                        {ticket.ticketTypeName && (
                          <span style={{ fontSize: '11px', color: '#6b7280' }}>
                            {ticket.ticketTypeName}
                          </span>
                        )}
                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                          {formatDate(ticket.createdAt)}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={16} style={{ color: '#d1d5db', flexShrink: 0 }} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer: Create Request Button */}
          {onCreateTicket && tickets.length > 0 && (
            <div
              style={{
                padding: '12px 16px',
                borderTop: '1px solid #f3f4f6',
                flexShrink: 0,
              }}
            >
              <button
                onClick={onCreateTicket}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#ffffff',
                  backgroundColor: '#3b82f6',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <Plus size={16} />
                Submit New Request
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
