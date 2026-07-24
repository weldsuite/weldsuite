
import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Calendar,
  Clock,
  Video,
  Phone,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';

interface AppointmentsViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateStatus?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

export function AppointmentsView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateStatus,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: AppointmentsViewProps) {
  const [activeTab] = useState('appointments');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedTime, setSelectedTime] = useState('');
  const [selectedType, setSelectedType] = useState<'video' | 'phone' | ''>('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const availableTimes = [
    '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'
  ];

  const handleSubmit = () => {
    setSubmitted(true);
    setTimeout(() => {
      onClose();
    }, 3000);
  };

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();
    
    const days = [];
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(null);
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i);
    }
    return days;
  };

  const isToday = (day: number) => {
    const today = new Date();
    return day === today.getDate() && 
           selectedDate.getMonth() === today.getMonth() && 
           selectedDate.getFullYear() === today.getFullYear();
  };

  const isPast = (day: number) => {
    const today = new Date();
    const checkDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day);
    return checkDate < today;
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
        <div className="w-8"></div>
        <h2 
          className="text-gray-900 absolute left-1/2 transform -translate-x-1/2"
          style={{
            fontSize: '15px',
            fontWeight: 500,
            letterSpacing: '-0.01em'
          }}
        >
          Book Appointment
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-md transition-all duration-150"
          aria-label="Close"
        >
          <X
            size={18}
            strokeWidth={2}
            className="text-gray-500"
          />
        </Button>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white subtle-scrollbar" style={{ padding: '16px', ...subtleScrollbarStyles }}>
        {!submitted ? (
          <div className="space-y-5">
            {/* Appointment Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Appointment Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setSelectedType('video')}
                  className={cn(
                    "p-4 rounded-lg border transition-all",
                    selectedType === 'video'
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  )}
                >
                  <Video size={20} className={selectedType === 'video' ? "text-blue-600 mb-2" : "text-gray-400 mb-2"} />
                  <p className="text-sm font-medium">Video Call</p>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setSelectedType('phone')}
                  className={cn(
                    "p-4 rounded-lg border transition-all",
                    selectedType === 'phone'
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-gray-300"
                  )}
                >
                  <Phone size={20} className={selectedType === 'phone' ? "text-blue-600 mb-2" : "text-gray-400 mb-2"} />
                  <p className="text-sm font-medium">Phone Call</p>
                </Button>
              </div>
            </div>

            {/* Calendar */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Select Date
              </label>
              <div className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-3">
                  <Button
                    variant="ghost"
                    onClick={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1))}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <ChevronLeft size={16} />
                  </Button>
                  <span className="text-sm font-medium">
                    {selectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1))}
                    className="p-1 hover:bg-gray-100 rounded"
                  >
                    <ChevronRight size={16} />
                  </Button>
                </div>
                
                <div className="grid grid-cols-7 gap-1 text-center">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day) => (
                    <div key={day} className="text-xs text-gray-500 py-1">{day}</div>
                  ))}
                  {getDaysInMonth(selectedDate).map((day, index) => (
                    <Button
                      key={index}
                      variant="ghost"
                      onClick={() => day && !isPast(day) && setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day))}
                      disabled={!day || isPast(day)}
                      className={cn(
                        "py-1.5 text-sm rounded transition-all",
                        !day && "invisible",
                        day && isPast(day) && "text-gray-300 cursor-not-allowed",
                        day && !isPast(day) && "hover:bg-gray-100",
                        day && isToday(day) && "bg-blue-100 text-blue-600 font-medium",
                        day && selectedDate.getDate() === day && !isToday(day) && "bg-gray-900 text-white"
                      )}
                    >
                      {day}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            {/* Time Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Select Time
              </label>
              <div className="grid grid-cols-3 gap-2">
                {availableTimes.map((time) => (
                  <Button
                    key={time}
                    variant="ghost"
                    onClick={() => setSelectedTime(time)}
                    className={cn(
                      "py-2 px-3 rounded-lg border text-sm transition-all",
                      selectedTime === time
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 hover:border-gray-300"
                    )}
                  >
                    {time}
                  </Button>
                ))}
              </div>
            </div>

            {/* Contact Info */}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full p-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-gray-300"
                  placeholder="John Smith"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full p-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-gray-300"
                  placeholder="john@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-2.5 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-1 focus:ring-gray-300"
                  rows={2}
                  placeholder="What would you like to discuss?"
                />
              </div>
            </div>

            {/* Submit Button */}
            <Button
              variant="ghost"
              onClick={handleSubmit}
              disabled={!selectedType || !selectedTime || !name || !email}
              className={cn(
                "w-full py-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                selectedType && selectedTime && name && email
                  ? "bg-gray-900 text-white hover:bg-black"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"
              )}
            >
              <Calendar size={16} />
              Book Appointment
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <Calendar size={32} className="text-green-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Appointment Booked!
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Your {selectedType} call is scheduled for:
            </p>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="font-medium text-gray-900">
                {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
              <p className="text-gray-600 flex items-center justify-center gap-1 mt-1">
                <Clock size={14} />
                {selectedTime}
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              You&apos;ll receive a confirmation email shortly
            </p>
          </div>
        )}
      </div>

      {/* Bottom Tab Bar with all navigation - Only show if more than 1 page is enabled */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white relative"
          style={{
            height: '60px',
            borderTop: '1px solid #E5E7EB',
            borderBottomLeftRadius: '16px',
            borderBottomRightRadius: '16px'
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
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: () => {} },
                { id: 'announcements', icon: Megaphone, label: 'Announce', onClick: onNavigateAnnouncements },
                { id: 'events', icon: Calendar, label: 'Events', onClick: onNavigateEvents },
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: onNavigateParcelTracking }
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
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
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}