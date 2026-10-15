
import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  Calendar,
  Megaphone,
  MapPin,
  Users,
  Clock,
  ExternalLink,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface EventsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
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
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'appointments', 'announcements', 'events', 'parcel-tracking']
}: Readonly<EventsViewProps>) {
  const { t, format } = useI18n();
  const [activeTab] = useState('events');
  const [registeredEvents, setRegisteredEvents] = useState<string[]>([]);

  const events: EventItem[] = [
    {
      id: '1',
      title: t.helpdeskWidget.events.items.roadmapWebinar.title,
      description: t.helpdeskWidget.events.items.roadmapWebinar.description,
      date: t.helpdeskWidget.events.items.roadmapWebinar.date,
      time: t.helpdeskWidget.events.items.roadmapWebinar.time,
      location: t.helpdeskWidget.events.online,
      attendees: 247,
      maxAttendees: 500,
      category: 'webinar',
      imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&h=200&fit=crop'
    },
    {
      id: '2',
      title: t.helpdeskWidget.events.items.analyticsWorkshop.title,
      description: t.helpdeskWidget.events.items.analyticsWorkshop.description,
      date: t.helpdeskWidget.events.items.analyticsWorkshop.date,
      time: t.helpdeskWidget.events.items.analyticsWorkshop.time,
      location: t.helpdeskWidget.events.online,
      attendees: 89,
      maxAttendees: 100,
      category: 'workshop',
      imageUrl: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&h=200&fit=crop'
    },
    {
      id: '3',
      title: t.helpdeskWidget.events.items.successSummit.title,
      description: t.helpdeskWidget.events.items.successSummit.description,
      date: t.helpdeskWidget.events.items.successSummit.date,
      time: t.helpdeskWidget.events.items.successSummit.time,
      location: 'San Francisco, CA',
      attendees: 342,
      maxAttendees: 1000,
      category: 'conference',
      imageUrl: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=800&h=200&fit=crop'
    },
    {
      id: '4',
      title: t.helpdeskWidget.events.items.nycMeetup.title,
      description: t.helpdeskWidget.events.items.nycMeetup.description,
      date: t.helpdeskWidget.events.items.nycMeetup.date,
      time: t.helpdeskWidget.events.items.nycMeetup.time,
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

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white z-[999999] overflow-hidden"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white relative"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        {/* Left spacer for balance */}
        <div className="w-8"></div>

        {/* Centered Title */}
        <h2
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '15px',
            fontWeight: 500,
            letterSpacing: '-0.01em'
          }}
        >
          {t.helpdeskWidget.events.title}
        </h2>

        {/* Close button */}
        <Button
          variant="ghost"
          onClick={onClose}
          className="hover:bg-gray-100 transition-colors rounded-sm flex items-center justify-center"
          style={{
            width: '28px',
            height: '28px'
          }}
        >
          <X size={18} strokeWidth={2} className="text-gray-600" />
        </Button>
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
                      {t.helpdeskWidget.events.categories[event.category]}
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
                      <span>{format(t.helpdeskWidget.events.attendees, { count: event.attendees, max: event.maxAttendees })}</span>
                      {isFilling && (
                        <span className="text-orange-600 font-medium">
                          ({format(t.helpdeskWidget.events.spotsLeft, { count: spotsRemaining })})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Register Button */}
                  <Button
                    variant="ghost"
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
                        <span>{t.helpdeskWidget.events.registered}</span>
                      </>
                    ) : (
                      <>
                        <span>{t.helpdeskWidget.events.registerNow}</span>
                        <ExternalLink size={14} />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Navigation - Only show if more than 1 page is enabled */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white"
          style={{
            height: '56px',
            borderTop: '1px solid #E5E7EB',
            borderBottomLeftRadius: '16px',
            borderBottomRightRadius: '16px'
          }}
        >
          <div className="flex items-center h-full overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <div className="flex items-center min-w-full px-2">
              {[
                { id: 'home', icon: Home, label: t.helpdeskWidget.nav.home, onClick: onNavigateHome },
                { id: 'messages', icon: MessageSquare, label: t.helpdeskWidget.nav.chat, onClick: onNavigateMessages },
                { id: 'help', icon: HelpCircle, label: t.helpdeskWidget.nav.help, onClick: onNavigateFAQ },
                { id: 'status', icon: Activity, label: t.helpdeskWidget.nav.status, onClick: onNavigateStatus },
                { id: 'changelog', icon: Sparkles, label: t.helpdeskWidget.nav.changelog, onClick: onNavigateChangelog },
                { id: 'news', icon: Sparkles, label: t.helpdeskWidget.nav.news, onClick: onNavigateNews },
                { id: 'appointments', icon: Calendar, label: t.helpdeskWidget.nav.book, onClick: onNavigateAppointments },
                { id: 'announcements', icon: Megaphone, label: t.helpdeskWidget.nav.announce, onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: t.helpdeskWidget.nav.events, onClick: () => {} },
                { id: 'parcel-tracking', icon: Package, label: t.helpdeskWidget.nav.track, onClick: onNavigateParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
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
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
