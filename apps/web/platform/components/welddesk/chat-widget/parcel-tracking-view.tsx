
import { useState } from 'react';
import {
  X,
  Search,
  Package,
  Truck,
  CheckCircle,
  MapPin,
  Calendar,
  Home,
  MessageSquare,
  HelpCircle,
  Activity,
  Sparkles,
  ChevronLeft
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';

interface ParcelTrackingViewProps {
  onClose: () => void;
  onNavigateHome?: () => void;
  onNavigateMessages?: () => void;
  onNavigateFAQ?: () => void;
  onNavigateStatus?: () => void;
  onNavigateChangelog?: () => void;
  onNavigateNews?: () => void;
  onNavigateAppointments?: () => void;
  onNavigateAnnouncements?: () => void;
  onNavigateEvents?: () => void;
  enabledPages?: string[];
  companyLogoUrl?: string;
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
  enabledPages = ['home', 'messages', 'help', 'status', 'changelog', 'news', 'appointments', 'announcements', 'events', 'parcel-tracking'],
  companyLogoUrl
}: ParcelTrackingViewProps) {
  const [trackingNumber, setTrackingNumber] = useState('');
  const [isTracking, setIsTracking] = useState(false);
  const [parcelInfo, setParcelInfo] = useState<ParcelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('parcel-tracking');

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
        iconColor: 'text-gray-400'
      },
      {
        id: '3',
        status: 'Received',
        location: 'Rotterdam Hub',
        timestamp: '2025-10-10 18:45',
        description: 'Package received at sorting facility',
        icon: MapPin,
        iconColor: 'text-gray-400'
      },
      {
        id: '4',
        status: 'Picked Up',
        location: 'Origin Warehouse',
        timestamp: '2025-10-10 10:00',
        description: 'Package picked up from sender',
        icon: CheckCircle,
        iconColor: 'text-gray-400'
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
        className="flex items-center justify-between bg-white"
        style={{
          height: '52px',
          padding: '0 16px',
          borderBottom: '1px solid #E5E7EB',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        {parcelInfo ? (
          <Button
            variant="ghost"
            onClick={() => {
              setParcelInfo(null);
              setTrackingNumber('');
            }}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-md transition-all duration-150 p-0"
            aria-label="Go back"
          >
            <ChevronLeft
              size={20}
              strokeWidth={2}
              className="text-gray-500"
            />
          </Button>
        ) : (
          <div className="w-8"></div>
        )}
        <h2
          className="text-center flex-1"
          style={{
            fontSize: '16px',
            fontWeight: 500,
            color: '#111827'
          }}
        >
          {parcelInfo ? 'Tracking Details' : 'Track Parcel'}
        </h2>
        <Button
          variant="ghost"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded-md transition-all duration-150 p-0"
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
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Tracking Input Section - Centered */}
        {!parcelInfo && (
          <div className="flex flex-col items-center justify-center px-6 h-full" style={{ marginTop: '-30px' }}>
            {/* Company Logo */}
            <div className="mb-6">
              {companyLogoUrl ? (
                <img
                  src={companyLogoUrl}
                  alt="Company logo"
                  className="h-16 max-w-[120px] object-contain"
                />
              ) : (
                <div className="w-16 h-16 bg-gray-900 rounded-2xl flex items-center justify-center">
                  <Package className="h-8 w-8 text-white" />
                </div>
              )}
            </div>

            <div className="w-full space-y-3">
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
              <Button
                variant="ghost"
                onClick={handleTrack}
                disabled={isTracking}
                className={cn(
                  "w-full py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium",
                  "hover:bg-black transition-colors duration-200",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                {isTracking ? 'Tracking...' : 'Track Parcel'}
              </Button>
              {error && (
                <p className="text-xs text-red-600 text-center">{error}</p>
              )}
            </div>
          </div>
        )}

        {/* Tracking Results */}
        {parcelInfo && (
          <div className="p-4 space-y-4">
            {/* Status Card */}
            <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-blue-900">
                    {parcelInfo.trackingNumber}
                  </span>
                </div>
                <span className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium",
                  getStatusColor(parcelInfo.status)
                )}>
                  {getStatusText(parcelInfo.status)}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2" style={{ fontSize: '13px' }}>
                  <Truck className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">{parcelInfo.carrier}</span>
                </div>
                <div className="flex items-center gap-2" style={{ fontSize: '13px' }}>
                  <MapPin className="h-4 w-4 text-blue-600" />
                  <span className="text-gray-700">{parcelInfo.currentLocation}</span>
                </div>
                <div className="flex items-center gap-2" style={{ fontSize: '13px' }}>
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
            <div className="pt-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Tracking History
              </h3>
              <div className="space-y-3">
                {parcelInfo.events.map((event, index) => (
                  <div key={event.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className={cn(
                        "w-8 h-8 rounded-md flex items-center justify-center",
                        index === 0 ? 'bg-blue-100' : 'bg-gray-100'
                      )}>
                        <event.icon className={cn("h-4 w-4", event.iconColor)} />
                      </div>
                      {index < parcelInfo.events.length - 1 && (
                        <div className="flex-1 bg-gray-200 my-1" style={{ width: '1.3px', minHeight: '24px', transform: 'translateY(5px)' }} />
                      )}
                    </div>
                    <div className="flex-1 pb-4">
                      <div className="flex items-start justify-between mb-1">
                        <p className="text-sm font-medium text-gray-900">{event.status}</p>
                        <span className="text-xs text-gray-500">{event.timestamp}</span>
                      </div>
                      <p className="text-xs text-gray-600">{event.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="pt-2 space-y-2">
              <Button variant="ghost" className="w-full py-2.5 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                View Full Details
              </Button>
            </div>
          </div>
        )}

      </div>

      {/* Bottom Navigation - Only show if more than 1 page is enabled */}
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
                { id: 'parcel-tracking', icon: Package, label: 'Track', onClick: () => {} },
              ].filter(tab => enabledPages.includes(tab.id)).map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (tab.onClick) tab.onClick();
                  }}
                  className="flex flex-col items-center justify-center px-3 py-2 transition-all group flex-1 min-w-[60px] h-auto"
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

      {/* Custom Scrollbar Styles */}
      <style>{`
        .scrollbar-thin {
          scrollbar-width: thin;
          scrollbar-color: rgba(156, 163, 175, 0.3) transparent;
        }

        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }

        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }

        .scrollbar-thin::-webkit-scrollbar-thumb {
          background-color: rgba(156, 163, 175, 0.3);
          border-radius: 3px;
        }

        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background-color: rgba(156, 163, 175, 0.5);
        }

        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
}
