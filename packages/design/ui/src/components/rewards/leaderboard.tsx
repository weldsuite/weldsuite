import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../card';
import { Avatar, AvatarFallback, AvatarImage } from '../avatar';
import { RewardBadge } from './reward-badge';
import { cn } from '../../lib/utils';
import { Trophy, Medal, Award } from 'lucide-react';

interface LeaderboardEntry {
  user: {
    id: string;
    name?: string | null;
    email: string;
    avatar?: string | null;
  };
  totalPoints: number;
  tier?: {
    name: string;
    badgeIcon?: string | null;
    badgeColor: string;
  } | null;
  currentStreak: number;
}

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  currentUserId?: string;
  className?: string;
}

export function Leaderboard({ entries, currentUserId, className }: LeaderboardProps) {
  const getRankIcon = (position: number) => {
    switch (position) {
      case 1:
        return <Trophy className="w-5 h-5 text-yellow-500" />;
      case 2:
        return <Medal className="w-5 h-5 text-gray-400" />;
      case 3:
        return <Award className="w-5 h-5 text-orange-600" />;
      default:
        return <span className="w-5 text-center font-bold text-muted-foreground">{position}</span>;
    }
  };

  const getRankStyle = (position: number) => {
    switch (position) {
      case 1:
        return 'bg-gradient-to-r from-yellow-50 to-yellow-100 border-yellow-300';
      case 2:
        return 'bg-gradient-to-r from-gray-50 to-gray-100 border-gray-300';
      case 3:
        return 'bg-gradient-to-r from-orange-50 to-orange-100 border-orange-300';
      default:
        return '';
    }
  };

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-yellow-500" />
          Leaderboard
        </CardTitle>
      </CardHeader>
      
      <CardContent className="p-0">
        <div className="divide-y">
          {entries.map((entry, index) => {
            const position = index + 1;
            const isCurrentUser = entry.user.id === currentUserId;
            
            return (
              <div
                key={entry.user.id}
                className={cn(
                  'flex items-center gap-4 p-4 transition-colors hover:bg-muted/50',
                  position <= 3 && getRankStyle(position),
                  isCurrentUser && 'bg-blue-50 border-l-4 border-l-blue-500'
                )}
              >
                <div className="flex items-center justify-center w-8">
                  {getRankIcon(position)}
                </div>
                
                <Avatar className="h-10 w-10">
                  <AvatarImage src={entry.user.avatar || undefined} />
                  <AvatarFallback>
                    {entry.user.name?.charAt(0) || entry.user.email.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {entry.user.name || entry.user.email}
                    {isCurrentUser && <span className="ml-2 text-sm text-blue-600">(You)</span>}
                  </p>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {entry.tier && (
                      <span className="flex items-center gap-1">
                        <span>{entry.tier.badgeIcon}</span>
                        <span>{entry.tier.name}</span>
                      </span>
                    )}
                    {entry.currentStreak > 0 && (
                      <span className="flex items-center gap-1">
                        🔥 {entry.currentStreak} day streak
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="text-right">
                  <p className="font-bold text-lg">{entry.totalPoints.toLocaleString()}</p>
                  <p className="text-sm text-muted-foreground">points</p>
                </div>
              </div>
            );
          })}
        </div>
        
        {entries.length === 0 && (
          <div className="p-8 text-center text-muted-foreground">
            No leaderboard data available yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}