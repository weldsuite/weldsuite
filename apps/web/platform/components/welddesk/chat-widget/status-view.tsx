
import React, { useState, useMemo } from 'react';
import {
  X,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Info,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Sparkles,
  Megaphone,
  Package
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { subtleScrollbarStyles, subtleScrollbarCSS } from './scrollbar-styles';
import { Button } from '@weldsuite/ui/components/button';

interface StatusViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  onNavigateParcelTracking?: () => void;
  enabledPages?: string[];
}

interface ServiceData {
  name: string;
  uptimePercentage: string;
  dailyStatus: ('operational' | 'minor' | 'moderate' | 'major')[];
}

export function StatusView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateFAQ,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  onNavigateParcelTracking,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'appointments', 'announcements', 'events', 'news', 'parcel-tracking']
}: StatusViewProps) {
  const [activeTab] = useState('status');
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [hoveredSegment, setHoveredSegment] = useState<{ service: number; day: number } | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [hideTimeout, setHideTimeout] = useState<NodeJS.Timeout | null>(null);
  const [, setHoveredService] = useState<number | null>(null);

  // Generate mock uptime data for each service
  const generateUptimeData = (): ('operational' | 'minor' | 'moderate' | 'major')[] => {
    const data: ('operational' | 'minor' | 'moderate' | 'major')[] = [];
    for (let i = 0; i < 90; i++) {
      const random = Math.random();
      if (random > 0.98) {
        data.push('major');
      } else if (random > 0.96) {
        data.push('moderate');
      } else if (random > 0.94) {
        data.push('minor');
      } else {
        data.push('operational');
      }
    }
    return data;
  };

  // Use useMemo to generate data only once, preventing color changes on hover
  const services: ServiceData[] = useMemo(() => [
    { name: 'Attio Cloud', uptimePercentage: '99.98%', dailyStatus: generateUptimeData() },
    { name: 'Attio Web Client', uptimePercentage: '100%', dailyStatus: generateUptimeData() },
    { name: 'Background Tasks', uptimePercentage: '99.95%', dailyStatus: generateUptimeData() },
    { name: 'Attio Cloud Storage', uptimePercentage: '99.99%', dailyStatus: generateUptimeData() },
    { name: 'Customer Helpdesk', uptimePercentage: '100%', dailyStatus: generateUptimeData() },
  ], []);

  const getSegmentColor = (status: 'operational' | 'minor' | 'moderate' | 'major') => {
    switch (status) {
      case 'operational': return '#10B981';
      case 'minor': return '#FCD34D';
      case 'moderate': return '#F59E0B';
      case 'major': return '#EF4444';
    }
  };

  const getStatusText = (status: 'operational' | 'minor' | 'moderate' | 'major') => {
    switch (status) {
      case 'operational': return 'Operational';
      case 'minor': return 'Minor degradation';
      case 'moderate': return 'Partial degradation';
      case 'major': return 'Major outage';
    }
  };

  const formatDateRange = () => {
    const start = new Date(currentMonth);
    start.setMonth(start.getMonth() - 3);
    const end = currentMonth;
    
    const startMonth = start.toLocaleDateString('en-US', { month: 'short' }).toLowerCase();
    const endMonth = end.toLocaleDateString('en-US', { month: 'short' }).toLowerCase();
    const year = end.getFullYear();
    
    return `${startMonth} ${year} – ${endMonth} ${year}`;
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    const newDate = new Date(currentMonth);
    newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1));
    setCurrentMonth(newDate);
  };

  const getDayLabel = (dayIndex: number) => {
    const date = new Date();
    date.setDate(date.getDate() - (89 - dayIndex));
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className="fixed bottom-[90px] right-5 flex flex-col bg-white dark:bg-background z-[999999] overflow-hidden"
      style={{
        width: '400px',
        height: 'min(680px, 88vh)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)'
      }}
    >
      {/* Header Bar */}
      <div
        className="flex items-center justify-between bg-white dark:bg-background border-b border-gray-200 dark:border-border"
        style={{
          height: '52px',
          padding: '0 16px',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        <div className="w-8"></div>
        <h2
          className="text-center flex-1 text-gray-900 dark:text-foreground"
          style={{
            fontSize: '16px',
            fontWeight: 500
          }}
        >
          System Status
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all duration-150"
          aria-label="Close"
        >
          <X
            size={18}
            strokeWidth={2}
            className="text-gray-500 dark:text-muted-foreground"
          />
        </Button>
      </div>

      {/* Content Area */}
      <style dangerouslySetInnerHTML={{ __html: subtleScrollbarCSS }} />
      <div className="flex-1 overflow-y-auto bg-white dark:bg-background subtle-scrollbar" style={{ padding: '12px', ...subtleScrollbarStyles }}>
        {/* Summary Status Card */}
        <div
          className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
          style={{
            borderRadius: '10px',
            padding: '14px',
            marginBottom: '12px'
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex-shrink-0"
              style={{
                width: '8px',
                height: '8px',
                backgroundColor: '#10B981',
                borderRadius: '50%'
              }}
            />
            <div className="flex-1">
              <p className="text-green-800 dark:text-green-300" style={{
                fontSize: '14px',
                fontWeight: 500,
                lineHeight: '1.4'
              }}>
                All systems operational
              </p>
            </div>
          </div>
        </div>

        {/* System Status Module */}
        <div
          className="bg-white dark:bg-secondary border border-gray-200 dark:border-border"
          style={{
            borderRadius: '10px',
            padding: '14px'
          }}
          aria-label="System status"
        >
          {/* Header Row */}
          <div style={{ marginBottom: '10px' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-gray-900 dark:text-foreground" style={{
                fontSize: '15px',
                fontWeight: 600
              }}>
                System status
              </h3>
              
              {/* Date Range Selector */}
              <div className="flex items-center">
                <Button
                  variant="ghost"
                  onClick={() => navigateMonth('prev')}
                  aria-label="Previous period"
                  className="transition-colors flex-shrink-0 hover:bg-gray-100 dark:hover:bg-accent active:bg-gray-200 dark:active:bg-gray-600"
                  style={{
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px'
                  }}
                >
                  <ChevronLeft size={16} className="text-gray-700 dark:text-muted-foreground" />
                </Button>

                <span className="text-gray-700 dark:text-muted-foreground" style={{
                  fontSize: '13px',
                  margin: '0 2px',
                  userSelect: 'none',
                  whiteSpace: 'nowrap'
                }}>
                  {formatDateRange()}
                </span>

                <Button
                  variant="ghost"
                  onClick={() => navigateMonth('next')}
                  aria-label="Next period"
                  className="transition-colors flex-shrink-0 hover:bg-gray-100 dark:hover:bg-accent active:bg-gray-200 dark:active:bg-gray-600"
                  style={{
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px'
                  }}
                >
                  <ChevronRight size={16} className="text-gray-700 dark:text-muted-foreground" />
                </Button>
              </div>
            </div>

            {/* Divider */}
            <div className="bg-gray-100 dark:bg-accent" style={{
              height: '1px',
              marginTop: '10px',
              marginLeft: '-14px',
              marginRight: '-14px'
            }} />
          </div>

          {/* Service Rows */}
          <div role="list">
            {services.map((service, serviceIndex) => (
              <React.Fragment key={service.name}>
                <div
                  role="listitem"
                  className="group hover:bg-gray-50 dark:hover:bg-gray-750"
                  style={{
                    padding: '8px 4px',
                    marginBottom: serviceIndex < services.length - 1 ? '10px' : '0',
                    borderRadius: '4px',
                    transition: 'background-color 0.15s',
                    cursor: 'pointer',
                    marginLeft: '-4px',
                    marginRight: '-4px'
                  }}
                >
                  {/* Top Line */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center" style={{ minWidth: 0 }}>
                      <div
                        className="flex-shrink-0"
                        style={{
                          width: '10px',
                          height: '10px',
                          backgroundColor: '#10B981',
                          borderRadius: '50%'
                        }}
                        aria-label={`${service.name} operational`}
                      />
                      <span className="text-gray-900 dark:text-foreground" style={{
                        fontSize: '14px',
                        fontWeight: 500,
                        marginLeft: '6px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {service.name}
                      </span>
                      <div className="relative inline-block ml-1 flex-shrink-0">
                        <Info
                          size={13}
                          className="text-gray-400 dark:text-muted-foreground cursor-help"
                          onMouseEnter={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setTooltipPosition({ x: rect.left, y: rect.bottom + 5 });
                          }}
                        />
                      </div>
                    </div>

                    <span className="text-gray-600 dark:text-muted-foreground" style={{
                      fontSize: '13px',
                      marginLeft: '8px',
                      flexShrink: 0
                    }}>
                      {service.uptimePercentage} uptime
                    </span>
                  </div>

                  {/* Mini Uptime Chart */}
                  <div 
                    style={{
                      display: 'flex',
                      gap: '2px',
                      height: '12px',
                      marginLeft: '0',
                      width: 'calc(100% + 16px)'
                    }}
                    onMouseEnter={() => {
                      // Track that we're hovering this service's chart
                      setHoveredService(serviceIndex);
                      // Clear any pending hide timeout
                      if (hideTimeout) {
                        clearTimeout(hideTimeout);
                        setHideTimeout(null);
                      }
                    }}
                    onMouseLeave={() => {
                      // Only hide tooltip when leaving the entire chart area
                      setHoveredService(null);
                      const timeout = setTimeout(() => {
                        setHoveredSegment(null);
                      }, 100);
                      setHideTimeout(timeout);
                    }}
                  >
                    {service.dailyStatus.slice(0, 50).map((status, dayIndex) => (
                      <div
                        key={dayIndex}
                        aria-label={`${getDayLabel(dayIndex * 2)}: ${getStatusText(status)}`}
                        style={{
                          width: '5px',
                          height: '12px',
                          borderRadius: '1px',
                          backgroundColor: getSegmentColor(status),
                          transition: 'transform 0.1s',
                          cursor: 'pointer',
                          position: 'relative',
                          flexShrink: 0
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'scaleY(1.2)';
                          
                          // Set the hovered segment and position
                          const rect = e.currentTarget.getBoundingClientRect();
                          setHoveredSegment({ service: serviceIndex, day: dayIndex });
                          setTooltipPosition({ x: rect.left + rect.width / 2, y: rect.top - 5 });
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'scaleY(1)';
                          // Don't hide tooltip here - let the parent container handle it
                        }}
                      />
                    ))}
                  </div>
                </div>
                
                {/* Horizontal divider between services */}
                {serviceIndex < services.length - 1 && (
                  <div className="bg-gray-200 dark:border-border" style={{
                    height: '1px',
                    margin: '12px 0 4px 0'
                  }} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Tooltip - Always rendered for smooth transitions */}
      <div
        className="bg-white dark:bg-secondary text-gray-900 dark:text-foreground"
        style={{
          position: 'fixed',
          left: tooltipPosition.x,
          top: tooltipPosition.y,
          transform: `translate(-50%, -100%) scale(${hoveredSegment ? 1 : 0.95})`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '12px',
          fontWeight: 500,
          zIndex: 1000000,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          opacity: hoveredSegment ? 1 : 0,
          visibility: hoveredSegment ? 'visible' : 'hidden',
          transition: 'all 0.1s cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      >
        {hoveredSegment && (
          <>{getDayLabel(hoveredSegment.day * 2)}: {getStatusText(services[hoveredSegment.service].dailyStatus[hoveredSegment.day])}</>
        )}
      </div>

      {/* Bottom Tab Bar with all navigation - Only show if more than 1 page is enabled */}
      {enabledPages.length > 1 && (
        <div
          className="bg-white dark:bg-background relative border-t border-gray-200 dark:border-border"
          style={{
            height: '60px',
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
                { id: 'status', icon: Activity, label: 'Status', onClick: () => {} },
                { id: 'changelog', icon: Sparkles, label: 'Changelog', onClick: onNavigateChangelog },
                { id: 'news', icon: Sparkles, label: 'News', onClick: onNavigateNews },
                { id: 'appointments', icon: Calendar, label: 'Book', onClick: onNavigateAppointments },
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
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground" : "text-gray-400 dark:text-muted-foreground"
                    )}
                    strokeWidth={activeTab === tab.id ? 2 : 1.5}
                  />
                  <span
                    className={cn(
                      "text-[10px] transition-colors",
                      activeTab === tab.id ? "text-gray-900 dark:text-foreground font-medium" : "text-gray-400 dark:text-muted-foreground"
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