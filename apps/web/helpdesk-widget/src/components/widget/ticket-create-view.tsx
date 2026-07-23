import { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, Send } from 'lucide-react';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';
import { platformApi } from '@/lib/api/client';
import { TicketDetailInline } from './ticket-status-view';

interface TicketTypeItem {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  fields?: TicketTypeField[];
}

interface TicketTypeField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'date' | 'checkbox' | 'email' | 'url';
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  helpText?: string;
  order: number;
}

interface TicketCreateViewProps {
  onClose: () => void;
  onBack?: () => void;
  onTicketCreated?: () => void;
  customerEmail?: string;
  customerName?: string;
  widgetId: string;
}

export function TicketCreateView({
  onClose,
  onBack,
  onTicketCreated,
  customerEmail,
  customerName,
  widgetId,
}: TicketCreateViewProps) {
  const isMobile = useMobileDetection();
  const viewportHeight = useViewportHeight();

  const [ticketTypes, setTicketTypes] = useState<TicketTypeItem[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [selectedType, setSelectedType] = useState<TicketTypeItem | null>(null);

  // Form state
  const [name, setName] = useState(customerName || '');
  const [email, setEmail] = useState(customerEmail || '');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, any>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submittedTicketId, setSubmittedTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTypes = async () => {
      try {
        const apiUrl = (platformApi as any).apiUrl || import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
        const response = await fetch(`${apiUrl}/api/tickets/types`, {
          headers: { 'x-widget-id': widgetId },
        });
        const result = await response.json();
        if (result.success && result.data) {
          setTicketTypes(result.data);
        }
      } catch (err) {
        console.error('[Widget] Failed to fetch ticket types:', err);
      } finally {
        setLoadingTypes(false);
      }
    };
    fetchTypes();
  }, [widgetId]);

  const handleSubmit = async () => {
    if (!email || !name || !subject) return;
    setSubmitting(true);
    setError(null);

    try {
      const apiUrl = (platformApi as any).apiUrl || import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';
      const response = await fetch(`${apiUrl}/api/tickets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-widget-id': widgetId,
        },
        body: JSON.stringify({
          customerEmail: email,
          customerName: name,
          subject,
          description: description || undefined,
          ticketTypeId: selectedType?.id || undefined,
          customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        }),
      });

      const result = await response.json();
      if (result.success && result.data) {
        setSubmittedTicketId(result.data.id);
      } else {
        setError(result.message || 'Failed to create ticket');
      }
    } catch (err) {
      console.error('[Widget] Failed to create ticket:', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCustomFieldChange = (key: string, value: any) => {
    setCustomFields(prev => ({ ...prev, [key]: value }));
  };

  const containerHeight = isMobile ? `${viewportHeight}px` : '600px';

  // Success state — show Intercom-style ticket detail
  if (submittedTicketId) {
    return (
      <div
        className="widget-view"
        style={{
          position: isMobile ? 'fixed' : 'absolute',
          bottom: isMobile ? 0 : '80px',
          right: isMobile ? 0 : '20px',
          width: isMobile ? '100%' : '400px',
          height: containerHeight,
          maxHeight: isMobile ? '100dvh' : '600px',
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
          <span style={{ flex: 1, fontSize: '16px', fontWeight: 600, color: '#111827' }}>
            Request Submitted
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

        <TicketDetailInline
          ticketId={submittedTicketId}
          widgetId={widgetId}
          onDone={() => onTicketCreated?.()}
        />
      </div>
    );
  }

  return (
    <div
      className="widget-view"
      style={{
        position: isMobile ? 'fixed' : 'absolute',
        bottom: isMobile ? 0 : '80px',
        right: isMobile ? 0 : '20px',
        width: isMobile ? '100%' : '400px',
        height: containerHeight,
        maxHeight: isMobile ? '100dvh' : '600px',
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
          onClick={() => {
            if (selectedType && ticketTypes.length > 1) {
              setSelectedType(null);
              setCustomFields({});
            } else if (onBack) {
              onBack();
            }
          }}
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
          {selectedType ? selectedType.name : 'Submit a Request'}
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
        {!selectedType && ticketTypes.length > 1 && !loadingTypes ? (
          /* Type selection */
          <div style={{ padding: '16px' }}>
            <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '12px' }}>
              What can we help you with?
            </p>
            {ticketTypes.map((type) => (
              <button
                key={type.id}
                onClick={() => setSelectedType(type)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '14px',
                  marginBottom: '8px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '12px',
                  backgroundColor: '#ffffff',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s',
                  borderLeft: type.color ? `3px solid ${type.color}` : '1px solid #e5e7eb',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f9fafb';
                  e.currentTarget.style.borderColor = '#d1d5db';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#ffffff';
                  e.currentTarget.style.borderColor = '#e5e7eb';
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>
                    {type.name}
                  </div>
                  {type.description && (
                    <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '2px' }}>
                      {type.description}
                    </div>
                  )}
                </div>
                <ChevronRight size={16} style={{ color: '#d1d5db', flexShrink: 0 }} />
              </button>
            ))}
          </div>
        ) : loadingTypes ? (
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
            <p style={{ fontSize: '14px', color: '#6b7280' }}>Loading...</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : (
          /* Form */
          <div style={{ padding: '20px' }}>
            {/* Name */}
            {!customerName && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Your Name <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '14px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {/* Email */}
            {!customerEmail && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                  Email <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '14px',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {/* Subject */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                Subject <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of your request"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: '14px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Description */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Provide more details..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: '14px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  outline: 'none',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Custom Fields */}
            {selectedType?.fields && selectedType.fields.length > 0 && (
              <>
                {[...selectedType.fields]
                  .sort((a, b) => a.order - b.order)
                  .map((field) => (
                    <div key={field.key} style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#374151', marginBottom: '4px' }}>
                        {field.label}
                        {field.required && <span style={{ color: '#ef4444' }}> *</span>}
                      </label>
                      {field.helpText && (
                        <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '4px' }}>{field.helpText}</p>
                      )}

                      {(field.type === 'text' || field.type === 'email' || field.type === 'url') && (
                        <input
                          type={field.type}
                          value={customFields[field.key] || ''}
                          onChange={(e) => handleCustomFieldChange(field.key, e.target.value)}
                          placeholder={field.placeholder || ''}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '14px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}

                      {field.type === 'number' && (
                        <input
                          type="number"
                          value={customFields[field.key] || ''}
                          onChange={(e) => handleCustomFieldChange(field.key, e.target.value)}
                          placeholder={field.placeholder || ''}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '14px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}

                      {field.type === 'textarea' && (
                        <textarea
                          value={customFields[field.key] || ''}
                          onChange={(e) => handleCustomFieldChange(field.key, e.target.value)}
                          placeholder={field.placeholder || ''}
                          rows={3}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '14px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            outline: 'none',
                            resize: 'vertical',
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}

                      {field.type === 'select' && field.options && (
                        <select
                          value={customFields[field.key] || ''}
                          onChange={(e) => handleCustomFieldChange(field.key, e.target.value)}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '14px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            outline: 'none',
                            backgroundColor: '#ffffff',
                            boxSizing: 'border-box',
                          }}
                        >
                          <option value="">{field.placeholder || 'Select...'}</option>
                          {field.options.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {field.type === 'multiselect' && field.options && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {field.options.map((opt) => {
                            const selected = (customFields[field.key] || []) as string[];
                            const isChecked = selected.includes(opt.value);
                            return (
                              <label
                                key={opt.value}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  fontSize: '14px',
                                  color: '#374151',
                                  cursor: 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    const newVal = isChecked
                                      ? selected.filter((v: string) => v !== opt.value)
                                      : [...selected, opt.value];
                                    handleCustomFieldChange(field.key, newVal);
                                  }}
                                />
                                {opt.label}
                              </label>
                            );
                          })}
                        </div>
                      )}

                      {field.type === 'date' && (
                        <input
                          type="date"
                          value={customFields[field.key] || ''}
                          onChange={(e) => handleCustomFieldChange(field.key, e.target.value)}
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            fontSize: '14px',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}

                      {field.type === 'checkbox' && (
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontSize: '14px',
                            color: '#374151',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!customFields[field.key]}
                            onChange={(e) => handleCustomFieldChange(field.key, e.target.checked)}
                          />
                          {field.placeholder || field.label}
                        </label>
                      )}
                    </div>
                  ))}
              </>
            )}

            {/* Error */}
            {error && (
              <p style={{ fontSize: '13px', color: '#ef4444', marginBottom: '12px' }}>{error}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer: Submit button (only on form step) */}
      {(selectedType || ticketTypes.length <= 1) && !loadingTypes && (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #f3f4f6',
            flexShrink: 0,
          }}
        >
          <button
            onClick={handleSubmit}
            disabled={submitting || !email || !name || !subject}
            style={{
              width: '100%',
              padding: '10px',
              fontSize: '14px',
              fontWeight: 500,
              color: '#ffffff',
              backgroundColor: submitting || !email || !name || !subject ? '#93c5fd' : '#3b82f6',
              border: 'none',
              borderRadius: '8px',
              cursor: submitting || !email || !name || !subject ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            {submitting ? (
              <>
                <div
                  style={{
                    width: '16px',
                    height: '16px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#ffffff',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                Submitting...
              </>
            ) : (
              <>
                <Send size={16} />
                Submit Request
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
