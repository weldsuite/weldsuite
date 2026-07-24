
import { Handshake, Plus, MoreHorizontal, DollarSign, Calendar, TrendingUp } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { DealsSectionProps, Opportunity } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

const stageColors: Record<string, string> = {
  lead: 'bg-muted text-foreground',
  qualified: 'bg-blue-100 text-blue-700',
  proposal: 'bg-purple-100 text-purple-700',
  negotiation: 'bg-orange-100 text-orange-700',
  closed_won: 'bg-green-100 text-green-700',
  closed_lost: 'bg-red-100 text-red-700',
};

function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DealsSection({ opportunities, totalCount }: DealsSectionProps) {
  const t = useTranslations();
  if (opportunities.length === 0) {
    return (
      <div className="text-center py-12">
        <Handshake className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-foreground mb-2">{t('sweep.weldcrm.dealsSection.noDealsYet')}</h3>
        <p className="text-sm text-muted-foreground mb-4">{t('sweep.weldcrm.dealsSection.noDealsYetDescription')}</p>
        <Button className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t('sweep.weldcrm.dealsSection.createDeal')}
        </Button>
      </div>
    );
  }

  // Calculate totals
  const totalValue = opportunities.reduce((sum, opp) => sum + (opp.amount || opp.value || 0), 0);
  const openDeals = opportunities.filter(o => o.stage !== 'closed_won' && o.stage !== 'closed_lost');
  const wonDeals = opportunities.filter(o => o.stage === 'closed_won');
  const wonValue = wonDeals.reduce((sum, opp) => sum + (opp.amount || opp.value || 0), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium text-foreground">{t('sweep.weldcrm.dealsSection.deals')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.dealsSection.dealCount', { count: totalCount })}</span>
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.dealsSection.newDeal')}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm">{t('sweep.weldcrm.dealsSection.openPipeline')}</span>
          </div>
          <p className="text-xl font-semibold text-foreground">
            {formatCurrency(totalValue - wonValue)}
          </p>
          <p className="text-xs text-muted-foreground">{t('sweep.weldcrm.dealsSection.dealCount', { count: openDeals.length })}</p>
        </div>

        <div className="bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm">{t('sweep.weldcrm.dealsSection.won')}</span>
          </div>
          <p className="text-xl font-semibold text-green-600">
            {formatCurrency(wonValue)}
          </p>
          <p className="text-xs text-muted-foreground">{t('sweep.weldcrm.dealsSection.dealCount', { count: wonDeals.length })}</p>
        </div>

        <div className="bg-background border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Handshake className="h-4 w-4" />
            <span className="text-sm">{t('sweep.weldcrm.dealsSection.totalValue')}</span>
          </div>
          <p className="text-xl font-semibold text-foreground">
            {formatCurrency(totalValue)}
          </p>
          <p className="text-xs text-muted-foreground">{t('sweep.weldcrm.dealsSection.dealCount', { count: totalCount })}</p>
        </div>
      </div>

      {/* Deals List */}
      <div className="space-y-2">
        {opportunities.map((deal) => (
          <DealCard key={deal.id} deal={deal} />
        ))}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: Opportunity }) {
  const t = useTranslations();
  const value = deal.amount || deal.value || 0;
  const stage = deal.stage || 'lead';

  return (
    <div className="flex items-center gap-4 p-4 bg-background border border-border rounded-lg hover:border-border transition-colors group">
      {/* Deal Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{deal.name || deal.title}</span>
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full",
            stageColors[stage] || 'bg-muted text-foreground'
          )}>
            {stage.replace('_', ' ')}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {formatCurrency(value, deal.currency)}
          </span>
          {deal.probability && (
            <>
              <span>·</span>
              <span>{t('sweep.weldcrm.dealsSection.probability', { percent: deal.probability })}</span>
            </>
          )}
          {deal.expectedCloseDate && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {t('sweep.weldcrm.dealsSection.closeDate', { date: formatDate(deal.expectedCloseDate) })}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.viewDeal')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.editDeal')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.dealsSection.addActivity')}</DropdownMenuItem>
          <DropdownMenuItem className="text-green-600">{t('sweep.weldcrm.dealsSection.markAsWon')}</DropdownMenuItem>
          <DropdownMenuItem className="text-red-600">{t('sweep.weldcrm.dealsSection.markAsLost')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
