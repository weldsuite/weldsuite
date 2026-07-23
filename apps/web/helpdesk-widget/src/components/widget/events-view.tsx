import React, { useState, useEffect } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  Calendar,
  FileText,
  Megaphone,
  MapPin,
  Users,
  Clock,
  ExternalLink,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { subtleScrollbarStyles, subtleScrollbarCSS } from '@/lib/utils/scrollbar-styles';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface EventsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface EventItem {
  id: string;
  title: string;
  description: string;
  date: string;
  time: string;
  location: string;
  attendees: number;
  maxAttendees: number;
  category: 'webinar' | 'workshop' | 'conference' | 'meetup';
  imageUrl: string;
}

export function EventsView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateFeedback,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking']
}: EventsViewProps) {
  const [activeTab] = useState('events');
  const [registeredEvents, setRegisteredEvents] = useState<string[]>([]);

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

  const events: EventItem[] = [
    {
      id: '1',
      title: 'Product Roadmap Webinar Q1 2025',
      description: 'Join us for an exclusive look at what\'s coming in Q1 2025. Learn about new features, improvements, and get your questions answered live.',
      date: 'January 15, 2025',
      time: '10:00 AM - 11:30 AM PST',
      location: 'Online',
      attendees: 247,
      maxAttendees: 500,
      category: 'webinar',
      imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&h=200&fit=crop'
    },
    {
      id: '2',
      title: 'Advanced Analytics Workshop',
      description: 'Deep dive into our analytics platform. Learn best practices, advanced techniques, and how to build custom dashboards.',
      date: 'January 22, 2025',
      time: '2:00 PM - 4:00 PM PST',
      location: 'Online',
      attendees: 89,
      maxAttendees: 100,
      category: 'workshop',
      imageUrl: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&h=200&fit=crop'
    },
    {
      id: '3',
      title: 'Customer Success Summit 2025',
      description: 'Network with fellow users, share success stories, and learn from industry experts at our annual summit.',
      date: 'February 5-6, 2025',
      time: '9:00 AM - 5:00 PM PST',
      location: 'San Francisco, CA',
      attendees: 342,
      maxAttendees: 1000,
      category: 'conference',
      imageUrl: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=800&h=200&fit=crop'
    },
    {
      id: '4',
      title: 'Local User Meetup - NYC',
      description: 'Connect with other users in the New York area. Casual networking, pizza, and product discussions.',
      date: 'January 30, 2025',
      time: '6:00 PM - 8:00 PM EST',
      location: 'New York, NY',
      attendees: 28,
      maxAttendees: 50,
      category: 'meetup',
      imageUrl: 'https://images.unsplash.com/photo-1511578314322-379afb476865?w=800&h=200&fit=crop'
    }
  ];

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'webinar':
        return 'bg-blue-100 text-blue-700';
      case 'workshop':
        return 'bg-purple-100 text-purple-700';
      case 'conference':
        return 'bg-green-100 text-green-700';
      case 'meetup':
        return 'bg-orange-100 text-orange-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const handleRegister = (eventId: string) => {
    if (registeredEvents.includes(eventId)) {
      setRegisteredEvents(registeredEvents.filter(id => id !== eventId));
    } else {
      setRegisteredEvents([...registeredEvents, eventId]);
    }
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
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            letterSpacing: '-0.01em'
          }}
        >
          Upcoming Events
        </h2>

        {/* Close button */}
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-all duration-150"
          style={{ marginRight: '-5px' }}
        >
          <X size={18} strokeWidth={2} className="text-gray-500" />
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto" style={subtleScrollbarStyles}>
        <style>{subtleScrollbarCSS}</style>

        <div className="p-4 space-y-4">
          {events.map((event) => {
            const isRegistered = registeredEvents.includes(event.id);
            const spotsRemaining = event.maxAttendees - event.attendees;
            const isFilling = spotsRemaining < event.maxAttendees * 0.2;

            return (
              <div
                key={event.id}
                className="bg-white border border-gray-200 rounded-lg overflow-hidden hover:shadow-md transition-shadow"
              >
                {/* Event Image */}
                <div
                  className="w-full h-32 bg-cover bg-center"
                  style={{ backgroundImage: `url(${event.imageUrl})` }}
                />

                <div className="p-4">
                  {/* Category Badge */}
                  <div className="mb-2">
                    <span className={cn("text-xs px-2 py-1 rounded-full font-medium capitalize", getCategoryColor(event.category))}>
                      {event.category}
                    </span>
                  </div>

                  {/* Event Title */}
                  <h3 className="font-semibold text-gray-900 text-sm mb-2">
                    {event.title}
                  </h3>

                  {/* Event Description */}
                  <p className="text-xs text-gray-600 mb-3 leading-relaxed">
                    {event.description}
                  </p>

                  {/* Event Details */}
                  <div className="space-y-1.5 mb-3">
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <Calendar size={14} className="text-gray-400" />
                      <span>{event.date}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <Clock size={14} className="text-gray-400" />
                      <span>{event.time}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <MapPin size={14} className="text-gray-400" />
                      <span>{event.location}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <Users size={14} className="text-gray-400" />
                      <span>{event.attendees} / {event.maxAttendees} attendees</span>
                      {isFilling && (
                        <span className="text-orange-600 font-medium">
                          ({spotsRemaining} spots left!)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Register Button */}
                  <button
                    onClick={() => handleRegister(event.id)}
                    className={cn(
                      "w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2",
                      isRegistered
                        ? "bg-green-100 text-green-700 hover:bg-green-200"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    )}
                  >
                    {isRegistered ? (
                      <>
                        <span>✓</span>
                        <span>Registered</span>
                      </>
                    ) : (
                      <>
                        <span>Register Now</span>
                        <ExternalLink size={14} />
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Navigation - only show if more than 1 page enabled */}
      {enabledPages.length > 1 && (
      <div
        className="bg-white"
        style={{
          height: '56px',
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
              { id: 'feedback', icon: FileText, label: 'Feedback', onClick: onNavigateFeedback },
              { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
              { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
              { id: 'events', icon: Calendar, label: 'Events', onClick: () => {} },
              { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
            ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
              <button
                key={tab.id}
                onClick={tab.onClick}
                className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px]"
              >
                <tab.icon
                  size={18}
                  className={cn(
                    "transition-colors mb-1",
                    activeTab === tab.id
                      ? "text-blue-600"
                      : "text-gray-400 group-hover:text-gray-600"
                  )}
                  strokeWidth={activeTab === tab.id ? 2.5 : 2}
                />
                <span
                  className={cn(
                    "text-[10px] transition-colors font-medium",
                    activeTab === tab.id
                      ? "text-blue-600"
                      : "text-gray-500 group-hover:text-gray-700"
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
