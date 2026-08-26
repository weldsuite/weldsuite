import { useState, useRef } from 'react';
import { useConversation } from '@/hooks/use-conversation';
import { useWidgetConfig } from '@/providers/widget-config-provider';
import { useCustomer } from '@/providers/customer-provider';
import { widgetApi } from '@/lib/api/client';
import { WidgetShell } from './widget-shell';
import { useMessagesScroll } from '@/hooks/use-messages-scroll';

interface ChatViewProps {
  onClose?: () => void;
}

export function ChatView({ onClose }: ChatViewProps) {
  const config = useWidgetConfig();
  const customer = useCustomer();
  const [inputValue, setInputValue] = useState('');
  const { messagesEndRef } = useMessagesScroll();
  const identified = Boolean(customer.email);

  const {
    messages,
    isLoading,
    isCreating,
    isClosed,
    typing,
    send,
    startTyping,
    stopTyping,
    visitorName,
  } = useConversation({
    widgetId: config.widgetId,
    name: customer.name || visitorName,
    email: customer.email,
    realtimeUrl: config.realtimeUrl,
  });

  const [nameDraft, setNameDraft] = useState(customer.name || '');
  const [emailDraft, setEmailDraft] = useState(customer.email || '');
  const submitted = useRef(false);

  const handleIdentify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailDraft.trim()) return;
    customer.setEmail(emailDraft.trim());
    if (nameDraft.trim()) customer.setName(nameDraft.trim());
    submitted.current = true;
    void widgetApi.identify(config.widgetId, {
      visitorId: customer.visitorId,
      name: nameDraft.trim() || undefined,
      email: emailDraft.trim(),
    });
  };

  const handleSend = () => {
    const body = inputValue.trim();
    if (!body) return;
    setInputValue('');
    void send(body);
  };

  if (!identified && !submitted.current) {
    return (
      <div className="flex flex-col h-full bg-white">
        <div className="px-4 py-3 text-white" style={{ backgroundColor: config.primaryColor }}>
          <div className="flex items-center justify-between">
            <p className="font-medium">Chat with us</p>
            {onClose && (
              <button type="button" onClick={onClose} className="text-white/80 hover:text-white text-sm">
                Close
              </button>
            )}
          </div>
        </div>
        <form onSubmit={handleIdentify} className="flex-1 p-4 space-y-3">
          <p className="text-sm text-gray-600">{config.greeting}</p>
          <label className="block text-sm">
            <span className="text-gray-700">Name</span>
            <input
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Your name"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700">Email</span>
            <input
              required
              type="email"
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-md py-2 text-sm text-white"
            style={{ backgroundColor: config.primaryColor }}
          >
            Start chat
          </button>
        </form>
      </div>
    );
  }

  return (
    <WidgetShell
      messages={messages}
      isTyping={typing}
      isLoadingMessages={isLoading || isCreating}
      messagesEndRef={messagesEndRef}
      inputValue={inputValue}
      onInputChange={(v) => {
        setInputValue(v);
        if (v) startTyping();
        else stopTyping();
      }}
      onSend={() => handleSend()}
      onClose={onClose}
      disableBackNavigation
      isConversationClosed={isClosed}
      showBranding={config.showBranding}
      parentOrigin={config.parentOrigin}
    />
  );
}
