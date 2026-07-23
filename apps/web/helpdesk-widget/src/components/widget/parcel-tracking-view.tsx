import { useState, useEffect } from 'react';
import {
  X,
  Search,
  Package,
  Truck,
  CheckCircle,
  Clock,
  MapPin,
  Calendar,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  FileText
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useMobileDetection, useViewportHeight } from '@/hooks';

interface ParcelTrackingViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateStatus?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateFeedback?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  enabledPages?: string[];
}

interface TrackingEvent {
  id: string;
  status: string;
  location: string;
  timestamp: string;
  description: string;
  icon: typeof Package;
  iconColor: string;
}

interface ParcelInfo {
  trackingNumber: string;
  status: 'in_transit' | 'delivered' | 'pending' | 'exception';
  carrier: string;
  estimatedDelivery: string;
  currentLocation: string;
  events: TrackingEvent[];
}

export function ParcelTrackingView({
  onClose,
  onNavigateHome,
  onNavigateMessages,
  onNavigateFAQ,
  onNavigateStatus,
  onNavigateChangelog,
  onNavigateNews,
  onNavigateFeedback,
  onNavigateAppointments,
  onNavigateAnnouncements,
  onNavigateEvents,
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'feedback', 'appointments', 'announcements', 'events', 'parcel-tracking']
}: ParcelTrackingViewProps) {
  const [trackingNumber, setTrackingNumber] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isTracking, setIsTracking] = useState(false);
  const [parcelInfo, setParcelInfo] = useState<ParcelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('parcel-tracking');

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

  // Mock tracking data
  const mockParcelData: ParcelInfo = {
    trackingNumber: 'TRK123456789',
    status: 'in_transit',
    carrier: 'DHL Express',
    estimatedDelivery: '2025-10-13',
    currentLocation: 'Amsterdam Distribution Center',
    events: [
      {
        id: '1',
        status: 'In Transit',
        location: 'Amsterdam Distribution Center',
        timestamp: '2025-10-11 14:30',
        description: 'Package is being processed at distribution center',
        icon: Truck,
        iconColor: 'text-blue-600'
      },
      {
        id: '2',
        status: 'Departed',
        location: 'Rotterdam Hub',
        timestamp: '2025-10-11 09:15',
        description: 'Package has departed from facility',
        icon: Package,
        iconColor: 'text-purple-600'
      },
      {
        id: '3',
        status: 'Received',
        location: 'Rotterdam Hub',
        timestamp: '2025-10-10 18:45',
        description: 'Package received at sorting facility',
        icon: MapPin,
        iconColor: 'text-green-600'
      },
      {
        id: '4',
        status: 'Picked Up',
        location: 'Origin Warehouse',
        timestamp: '2025-10-10 10:00',
        description: 'Package picked up from sender',
        icon: CheckCircle,
        iconColor: 'text-gray-600'
      }
    ]
  };

  const handleTrack = () => {
    setError(null);
    if (!trackingNumber.trim()) {
      setError('Please enter a tracking number');
      return;
    }

    setIsTracking(true);
    // Simulate API call
    setTimeout(() => {
      setParcelInfo(mockParcelData);
      setIsTracking(false);
    }, 1000);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'bg-green-100 text-green-700';
      case 'in_transit':
        return 'bg-blue-100 text-blue-700';
      case 'pending':
        return 'bg-yellow-100 text-yellow-700';
      case 'exception':
        return 'bg-red-100 text-red-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'Delivered';
      case 'in_transit':
        return 'In Transit';
      case 'pending':
        return 'Pending';
      case 'exception':
        return 'Exception';
      default:
        return 'Unknown';
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
        className="flex items-center justify-between bg-white"
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
          className="text-center flex-1"
          style={{
            fontSize: '16px',
            fontWeight: 560,
            color: '#111827',
            letterSpacing: '-0.01em'
          }}
        >
          Track Parcel
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
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Tracking Input Section */}
        <div className="p-4 bg-gray-50 border-b border-gray-100">
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Enter tracking number..."
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    handleTrack();
                  }
                }}
                className={cn(
                  "w-full pl-9 pr-3 py-2.5 bg-white rounded-lg text-sm",
                  "placeholder:text-gray-400 transition-all duration-200",
                  "focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-200"
                )}
              />
            </div>
            <button
              onClick={handleTrack}
              disabled={isTracking}
              className={cn(
                "w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium",
                "hover:bg-blue-700 transition-colors duration-200",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {isTracking ? 'Tracking...' : 'Track Parcel'}
            </button>
            {error && (
              <p className="text-xs text-red-600">{error}</p>
            )}
          </div>
        </div>

        {/* Tracking Results */}
        {parcelInfo && (
          <div className="p-4 space-y-4">
            {/* Status Card */}
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4 border border-blue-200">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-blue-600" />
                  <span className="text-xs font-medium text-blue-900">
                    {parcelInfo.trackingNumber}
                  </span>
                </div>
                <span className={cn(
                  "px-2.5 py-1 rounded-full text-xs font-medium",
                  getStatusColor(parcelInfo.status)
                )}>
                  {getStatusText(parcelInfo.status)}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Truck className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">{parcelInfo.carrier}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">{parcelInfo.currentLocation}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">
                    Est. Delivery: {new Date(parcelInfo.estimatedDelivery).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </span>
                </div>
              </div>
            </div>

            {/* Tracking Timeline */}
            <div>
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Tracking History
              </h3>
              <div className="space-y-3">
                {parcelInfo.events.map((event, index) => (
                  <div key={event.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center",
                        index === 0 ? 'bg-blue-100' : 'bg-gray-100'
                      )}>
                        <event.icon className={cn("h-4 w-4", event.iconColor)} />
                      </div>
                      {index < parcelInfo.events.length - 1 && (
                        <div className="w-0.5 flex-1 bg-gray-200 my-1" style={{ minHeight: '24px' }} />
                      )}
                    </div>
                    <div className="flex-1 pb-4">
                      <div className="flex items-start justify-between mb-1">
                        <p className="text-sm font-medium text-gray-900">{event.status}</p>
                        <span className="text-xs text-gray-500">{event.timestamp}</span>
                      </div>
                      <p className="text-xs text-gray-600 mb-1">{event.description}</p>
                      <p className="text-xs text-gray-500 flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {event.location}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-2 space-y-2">
              <button className="w-full py-2.5 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                View Full Details
              </button>
              <button
                onClick={() => {
                  setParcelInfo(null);
                  setTrackingNumber('');
                }}
                className="w-full py-2.5 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Track Another Parcel
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!parcelInfo && !isTracking && (
          <div className="p-6 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Package className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-sm font-medium text-gray-900 mb-1">Track Your Parcel</h3>
            <p className="text-xs text-gray-500">
              Enter your tracking number above to see real-time updates on your delivery
            </p>
          </div>
        )}
      </div>

      {/* Bottom Navigation - only show if more than 1 page enabled */}
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
              { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: () => {} },
            ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.onClick) tab.onClick();
                }}
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
