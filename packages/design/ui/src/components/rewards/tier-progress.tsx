import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../card';
import { Progress } from '../progress';
import { RewardBadge } from './reward-badge';
import { cn } from '../../lib/utils';
import { ChevronRight, Star, Trophy } from 'lucide-react';

interface TierProgressProps {
  currentTier?: {
    name: string;
    level: number;
    badgeIcon?: string | null;
    badgeColor: string;
    description?: string | null;
    benefits?: string[] | null;
  } | null;
  nextTier?: {
    name: string;
    level: number;
    requiredPoints: number;
    badgeIcon?: string | null;
    badgeColor: string;
    description?: string | null;
    benefits?: string[] | null;
  } | null;
  totalPoints: number;
  className?: string;
}

function parseBenefits(benefits: string[] | string | null | undefined): string[] {
  if (!benefits) return [];
  const list: string[] = typeof benefits === 'string' ? JSON.parse(benefits) : benefits;
  // A benefit is its own list key, so a duplicate entry is shown once.
  return [...new Set(list)];
}

export function TierProgress({
  currentTier,
  nextTier,
  totalPoints,
  className
}: Readonly<TierProgressProps>) {
  const currentTierPoints = currentTier ? totalPoints : 0;
  const progressToNext = nextTier
    ? ((totalPoints - currentTierPoints) / nextTier.requiredPoints) * 100
    : 100;

  const currentBenefits = parseBenefits(currentTier?.benefits);

  const nextBenefits = parseBenefits(nextTier?.benefits);

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-yellow-500" />
          Tier Progress
        </CardTitle>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          {currentTier ? (
            <div className="flex items-center gap-3">
              <RewardBadge
                icon={currentTier.badgeIcon || undefined}
                color={currentTier.badgeColor}
                name={currentTier.name}
                size="md"
              />
              <div>
                <p className="font-semibold">{currentTier.name}</p>
                <p className="text-sm text-muted-foreground">
                  Level {currentTier.level}
                </p>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground">No tier yet</div>
          )}
          
          {nextTier && (
            <>
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
              <div className="flex items-center gap-3">
                <RewardBadge
                  icon={nextTier.badgeIcon || undefined}
                  color={nextTier.badgeColor}
                  name={nextTier.name}
                  size="md"
                />
                <div>
                  <p className="font-semibold">{nextTier.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {nextTier.requiredPoints.toLocaleString()} points
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {nextTier && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Progress to {nextTier.name}</span>
              <span className="font-medium">
                {totalPoints.toLocaleString()} / {nextTier.requiredPoints.toLocaleString()}
              </span>
            </div>
            <Progress value={progressToNext} className="h-3" />
          </div>
        )}

        {currentBenefits.length > 0 && (
          <div className="pt-3 border-t">
            <p className="text-sm font-medium mb-2">Current Benefits:</p>
            <ul className="space-y-1">
              {currentBenefits.map((benefit: string) => (
                <li key={benefit} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Star className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {nextTier && nextBenefits.length > 0 && (
          <div className="pt-3 border-t">
            <p className="text-sm font-medium mb-2">Next Tier Benefits:</p>
            <ul className="space-y-1">
              {nextBenefits.map((benefit: string) => (
                <li key={benefit} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Star className="w-3 h-3 text-gray-400 mt-0.5 flex-shrink-0" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}