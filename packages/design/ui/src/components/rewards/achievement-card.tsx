import * as React from 'react';
import { Card, CardContent, CardHeader } from '../card';
import { Progress } from '../progress';
import { RewardBadge } from './reward-badge';
import { cn } from '../lib/utils';
import { CheckCircle2, Lock, Trophy } from 'lucide-react';

interface AchievementCardProps {
  name: string;
  description: string;
  icon?: string;
  color?: string;
  progress: number;
  threshold: number;
  points: number;
  completed: boolean;
  completedAt?: Date | null;
  isPhysical?: boolean;
  physicalReward?: string | null;
  onClaim?: () => void;
  claimable?: boolean;
  className?: string;
}

export function AchievementCard({
  name,
  description,
  icon,
  color,
  progress,
  threshold,
  points,
  completed,
  completedAt,
  isPhysical,
  physicalReward,
  onClaim,
  claimable,
  className
}: AchievementCardProps) {
  const progressPercentage = Math.min((progress / threshold) * 100, 100);

  return (
    <Card className={cn(
      'relative overflow-hidden transition-all hover:shadow-lg',
      completed && 'border-green-500 bg-green-50/50',
      className
    )}>
      {completed && (
        <div className="absolute top-2 right-2">
          <CheckCircle2 className="w-6 h-6 text-green-500" />
        </div>
      )}
      
      <CardHeader className="pb-3">
        <div className="flex items-start gap-4">
          <RewardBadge 
            icon={icon} 
            color={completed ? color : '#9ca3af'} 
            name={name}
            size="md"
          />
          <div className="flex-1">
            <h3 className="font-semibold text-lg">{name}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
            
            {isPhysical && physicalReward && (
              <div className="flex items-center gap-1 mt-2 text-sm text-orange-600">
                <Trophy className="w-4 h-4" />
                <span className="font-medium">Physical Reward: {physicalReward}</span>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent>
        <div className="space-y-3">
          {!completed ? (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">
                  {progress.toLocaleString()} / {threshold.toLocaleString()}
                </span>
              </div>
              <Progress value={progressPercentage} className="h-2" />
            </>
          ) : (
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">Completed</span>
                {completedAt && (
                  <span className="ml-2 font-medium">
                    {new Date(completedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              {claimable && onClaim && (
                <button
                  onClick={onClaim}
                  className="px-3 py-1 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
                >
                  Claim Reward
                </button>
              )}
            </div>
          )}
          
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-sm text-muted-foreground">Reward Points</span>
            <span className="font-bold text-lg text-blue-600">
              +{points.toLocaleString()}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}