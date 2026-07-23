import React, { useState, useEffect } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  ThumbsUp,
  Star,
  Send,
  Calendar,
  FileText,
  Sparkles,
  MessageSquareText,
  Lightbulb,
  Bug,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface FeedbackViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

export function FeedbackView({ onClose, onNavigateHome, onNavigateMessages, onNavigateStatus, onNavigateFAQ, onNavigateChangelog, onNavigateNews, onNavigateAppointments, onNavigateAnnouncements, onNavigateEvents, onNavigateParcelTracking, enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking'] }: FeedbackViewProps) {
  const [activeTab] = useState('feedback');
  const [rating, setRating] = useState(0);
  const [feedbackType, setFeedbackType] = useState<'idea' | 'issue' | 'praise' | ''>('');
  const [feedbackText, setFeedbackText] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  // Detect if we're embedded in an iframe (SDK mode)
  const [isEmbedded, setIsEmbedded] = useState(false);
  const isMobile = useMobileDetection();
  const viewport = useViewportHeight();

  useEffect(() => {
    try {
      setIsEmbedded(window.self !== window.top);
    } catch {
      // Cross-origin iframe - we're definitely embedded
      setIsEmbedded(true);
    }
  }, []);

  // Determine if we should use full-screen mode
  const isFullScreen = isEmbedded || isMobile;

  const handleSubmit = () => {
    // Here you would normally send the feedback to your backend
    setSubmitted(true);
    setTimeout(() => {
      onClose();
    }, 2000);
  };

  // Container styles for embedded vs standalone mode
  // In embedded mode, SDK container handles border and shadow
  const containerStyles: React.CSSProperties = isFullScreen
    ? {
        // Embedded mode (mobile or desktop): fill entire iframe
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
      }
    : {
        // Desktop standalone: floating widget with own border/shadow
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        border: '1px solid rgba(0, 0, 0, 0.1)',
      };

  return (
    <div
      className={cn(
        'flex flex-col bg-white overflow-hidden',
        !isFullScreen && 'fixed bottom-[90px] right-5 z-[999999]'
      )}
      style={containerStyles}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white relative"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: isMobile ? '0' : '16px',
          borderTopRightRadius: isMobile ? '0' : '16px'
        }}
      >
        <div className="w-8"></div>
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            letterSpacing: '-0.01em'
          }}
        >
          Feedback
        </h2>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          style={{ marginRight: '-5px' }}
          aria-label="Close"
        >
          <X
            size={18}
            strokeWidth={2}
            className="text-gray-500"
          />
        </button>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-gray-50/50 subtle-scrollbar" style={{ ...subtleScrollbarStyles }}>
        {!submitted ? (
          <div className="p-6 pb-2 space-y-6">
            {/* Header Section */}
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                Send us feedback
              </h3>
              <p className="text-sm text-gray-500">
                Help us improve our product
              </p>
            </div>

            {/* Feedback Type Cards - shadcn style */}
            <div>
              <label className="text-sm font-medium text-gray-900 block mb-1.5">
                What type of feedback?
              </label>
              <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => setFeedbackType('praise')}
                className={cn(
                  "relative flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border bg-white transition-all",
                  "hover:bg-gray-50",
                  feedbackType === 'praise'
                    ? "border-gray-900 ring-1 ring-gray-900"
                    : "border-gray-200"
                )}
              >
                <MessageSquareText
                  size={16}
                  className={cn(
                    feedbackType === 'praise' ? "text-gray-900" : "text-gray-500"
                  )}
                />
                <span className={cn(
                  "text-sm font-medium",
                  feedbackType === 'praise' ? "text-gray-900" : "text-gray-600"
                )}>
                  Praise
                </span>
              </button>

              <button
                onClick={() => setFeedbackType('idea')}
                className={cn(
                  "relative flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border bg-white transition-all",
                  "hover:bg-gray-50",
                  feedbackType === 'idea'
                    ? "border-gray-900 ring-1 ring-gray-900"
                    : "border-gray-200"
                )}
              >
                <Lightbulb
                  size={16}
                  className={cn(
                    feedbackType === 'idea' ? "text-gray-900" : "text-gray-500"
                  )}
                />
                <span className={cn(
                  "text-sm font-medium",
                  feedbackType === 'idea' ? "text-gray-900" : "text-gray-600"
                )}>
                  Idea
                </span>
              </button>

              <button
                onClick={() => setFeedbackType('issue')}
                className={cn(
                  "relative flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border bg-white transition-all",
                  "hover:bg-gray-50",
                  feedbackType === 'issue'
                    ? "border-gray-900 ring-1 ring-gray-900"
                    : "border-gray-200"
                )}
              >
                <Bug
                  size={16}
                  className={cn(
                    feedbackType === 'issue' ? "text-gray-900" : "text-gray-500"
                  )}
                />
                <span className={cn(
                  "text-sm font-medium",
                  feedbackType === 'issue' ? "text-gray-900" : "text-gray-600"
                )}>
                  Issue
                </span>
              </button>
              </div>
            </div>

            {/* Message Input - shadcn textarea style */}
            <div>
              <label className="text-sm font-medium text-gray-900 block mb-1.5">
                Message
              </label>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Tell us what you think..."
                className={cn(
                  "flex min-h-[120px] w-full rounded-md border border-gray-200 bg-white px-3 py-2",
                  "text-sm placeholder:text-gray-500",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                rows={5}
              />
            </div>

            {/* Email Input - shadcn input style */}
            <div>
              <label className="text-sm font-medium text-gray-900 block mb-1.5">
                Email <span className="text-gray-500 font-normal">(optional)</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={cn(
                  "flex h-10 w-full rounded-md border border-gray-200 bg-white px-3 py-2",
                  "text-sm placeholder:text-gray-500",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              />
            </div>

            {/* Rating Section - shadcn style */}
            <div>
              <label className="text-sm font-medium text-gray-900 block mb-1.5">
                Overall satisfaction
              </label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setRating(star)}
                    className="p-1 hover:bg-gray-100 rounded transition-colors"
                  >
                    <Star
                      size={20}
                      className={cn(
                        "transition-colors",
                        star <= rating
                          ? "fill-gray-900 text-gray-900"
                          : "fill-transparent text-gray-300"
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <ThumbsUp size={24} className="text-gray-900" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-2">
              Thanks for your feedback!
            </h3>
            <p className="text-sm text-gray-500">
              We'll review it and get back to you if needed.
            </p>
          </div>
        )}
      </div>

      {/* Submit Button - Fixed at bottom like chat page */}
      {!submitted && (
        <div
          className="bg-gray-50/50"
          style={{
            padding: '12px 16px'
          }}
        >
          <button
            onClick={handleSubmit}
            disabled={!feedbackText.trim()}
            className={cn(
              "w-full flex items-center justify-center transition-all duration-200",
              feedbackText.trim()
                ? "bg-gray-900 hover:bg-black text-white"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            )}
            style={{
              height: '40px',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 500,
              letterSpacing: '-0.01em'
            }}
          >
            Send feedback
          </button>
        </div>
      )}

      {/* Bottom Tab Bar with all navigation - only show if more than 1 page enabled */}
      {enabledPages.length > 1 && (
      <div
        className="bg-white relative"
        style={{
          height: '60px',
          borderTop: '1px solid #E5E7EB',
          borderBottomLeftRadius: isMobile ? '0' : '16px',
          borderBottomRightRadius: isMobile ? '0' : '16px'
        }}
      >
        <div className="flex items-center h-full overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          <div className="flex items-center min-w-full px-2">
            {[
              { id: 'home', icon: Home, label: 'Home', onClick: onNavigateHome },
              { id: 'messages', icon: MessageSquare, label: 'Chat', onClick: onNavigateMessages },
              { id: 'help', icon: HelpCircle, label: 'Help', onClick: onNavigateFAQ },
              { id: 'status', icon: Activity, label: 'Status', onClick: onNavigateStatus },
              { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
              { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
              { id: 'feedback', icon: FileText, label: 'Feedback', onClick: () => {} },
              { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
              { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
              { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
              { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
            ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
              <button
                key={tab.id}
                onClick={tab.onClick}
                className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px]"
                aria-label={tab.label}
              >
                <tab.icon
                  size={18}
                  className={cn(
                    "mb-1 transition-colors",
                    activeTab === tab.id ? "text-gray-900" : "text-gray-400"
                  )}
                  strokeWidth={activeTab === tab.id ? 2 : 1.5}
                />
                <span
                  className={cn(
                    "text-[10px] transition-colors",
                    activeTab === tab.id ? "text-gray-900 font-medium" : "text-gray-400"
                  )}
                >
                  {tab.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
