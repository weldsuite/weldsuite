import * as React from 'react';
import { cn } from '../../lib/utils';
import { Trophy, X, ChevronRight } from 'lucide-react';
import { RewardBadge } from './reward-badge';

interface AchievementNotificationProps {
  id: string;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  points: number;
  isPhysical?: boolean;
  physicalReward?: string | null;
  onClose?: (id: string) => void;
  onViewDetails?: (id: string) => void;
  className?: string;
}

export function AchievementNotification({
  id,
  name,
  description,
  icon,
  color = '#10b981',
  points,
  isPhysical,
  physicalReward,
  onClose,
  onViewDetails,
  className
}: AchievementNotificationProps) {
  const [isVisible, setIsVisible] = React.useState(false);
  const [isExiting, setIsExiting] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      handleClose();
    }, 8000); // Auto-dismiss after 8 seconds
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => {
      onClose?.(id);
    }, 300);
  };

  return (
    <div
      className={cn(
        'fixed top-4 right-4 z-50 w-96 bg-white rounded-lg shadow-2xl border border-green-200 overflow-hidden transition-all duration-300',
        isVisible && !isExiting ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0',
        className
      )}
    >
      <div className="bg-gradient-to-r from-green-500 to-emerald-600 p-1" />
      
      <div className="p-4">
        <div className="flex items-start gap-3">
          <RewardBadge
            icon={icon}
            color={color}
            name={name}
            size="md"
          />
          
          <div className="flex-1">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-bold text-lg text-gray-900">Achievement Unlocked!</h3>
                <p className="font-semibold text-gray-800 mt-1">{name}</p>
                <p className="text-sm text-gray-600 mt-1">{description}</p>
              </div>
              <button
                onClick={handleClose}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>
            
            <div className="flex items-center gap-4 mt-3">
              <div className="flex items-center gap-1">
                <span className="text-2xl font-bold text-green-600">+{points}</span>
                <span className="text-sm text-gray-600">points</span>
              </div>
              
              {isPhysical && (
                <div className="flex items-center gap-1 text-orange-600">
                  <Trophy className="w-4 h-4" />
                  <span className="text-sm font-medium">Physical Reward!</span>
                </div>
              )}
            </div>
            
            {physicalReward && (
              <p className="text-sm text-gray-600 mt-2 italic">
                Reward: {physicalReward}
              </p>
            )}
            
            {onViewDetails && (
              <button
                onClick={() => onViewDetails(id)}
                className="flex items-center gap-1 mt-3 text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
              >
                View Details
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>
      
      <div className="bg-gradient-to-r from-green-500 to-emerald-600 h-1 animate-pulse" />
    </div>
  );
}

interface NotificationContainerProps {
  notifications: Array<{
    id: string;
    achievement: any;
    milestone: any;
  }>;
  onClose: (id: string) => void;
  onViewDetails?: (id: string) => void;
}

export function AchievementNotificationContainer({
  notifications,
  onClose,
  onViewDetails
}: NotificationContainerProps) {
  return (
    <div className="fixed top-4 right-4 z-50 space-y-3">
      {notifications.map((notification, index) => (
        <div
          key={notification.id}
          style={{
            transform: `translateY(${index * 10}px)`,
            zIndex: 50 - index
          }}
        >
          <AchievementNotification
            id={notification.id}
            name={notification.milestone.name}
            description={notification.milestone.description}
            icon={notification.milestone.badgeIcon}
            color={notification.milestone.badgeColor}
            points={notification.milestone.points}
            isPhysical={notification.milestone.isPhysical}
            physicalReward={notification.milestone.physicalReward}
            onClose={onClose}
            onViewDetails={onViewDetails}
          />
        </div>
      ))}
    </div>
  );
}