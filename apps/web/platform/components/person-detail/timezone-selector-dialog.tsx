
import { useState, useEffect, useMemo } from 'react';
import { Clock, Search, Check } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { useTranslations } from '@weldsuite/i18n/client';

interface Timezone {
  id: string;
  name: string;
  offset: string;
  region: string;
}

const TIMEZONES: Timezone[] = [
  // UTC
  { id: 'UTC', name: 'UTC', offset: '+00:00', region: 'Universal' },

  // Americas
  { id: 'America/New_York', name: 'New York', offset: '-05:00', region: 'Americas' },
  { id: 'America/Chicago', name: 'Chicago', offset: '-06:00', region: 'Americas' },
  { id: 'America/Denver', name: 'Denver', offset: '-07:00', region: 'Americas' },
  { id: 'America/Los_Angeles', name: 'Los Angeles', offset: '-08:00', region: 'Americas' },
  { id: 'America/Anchorage', name: 'Anchorage', offset: '-09:00', region: 'Americas' },
  { id: 'America/Toronto', name: 'Toronto', offset: '-05:00', region: 'Americas' },
  { id: 'America/Vancouver', name: 'Vancouver', offset: '-08:00', region: 'Americas' },
  { id: 'America/Mexico_City', name: 'Mexico City', offset: '-06:00', region: 'Americas' },
  { id: 'America/Sao_Paulo', name: 'São Paulo', offset: '-03:00', region: 'Americas' },
  { id: 'America/Buenos_Aires', name: 'Buenos Aires', offset: '-03:00', region: 'Americas' },
  { id: 'America/Lima', name: 'Lima', offset: '-05:00', region: 'Americas' },
  { id: 'America/Bogota', name: 'Bogota', offset: '-05:00', region: 'Americas' },

  // Europe
  { id: 'Europe/London', name: 'London', offset: '+00:00', region: 'Europe' },
  { id: 'Europe/Paris', name: 'Paris', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Berlin', name: 'Berlin', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Amsterdam', name: 'Amsterdam', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Brussels', name: 'Brussels', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Madrid', name: 'Madrid', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Rome', name: 'Rome', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Zurich', name: 'Zurich', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Vienna', name: 'Vienna', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Stockholm', name: 'Stockholm', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Oslo', name: 'Oslo', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Copenhagen', name: 'Copenhagen', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Helsinki', name: 'Helsinki', offset: '+02:00', region: 'Europe' },
  { id: 'Europe/Athens', name: 'Athens', offset: '+02:00', region: 'Europe' },
  { id: 'Europe/Istanbul', name: 'Istanbul', offset: '+03:00', region: 'Europe' },
  { id: 'Europe/Moscow', name: 'Moscow', offset: '+03:00', region: 'Europe' },
  { id: 'Europe/Kiev', name: 'Kyiv', offset: '+02:00', region: 'Europe' },
  { id: 'Europe/Warsaw', name: 'Warsaw', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Prague', name: 'Prague', offset: '+01:00', region: 'Europe' },
  { id: 'Europe/Dublin', name: 'Dublin', offset: '+00:00', region: 'Europe' },
  { id: 'Europe/Lisbon', name: 'Lisbon', offset: '+00:00', region: 'Europe' },

  // Asia
  { id: 'Asia/Dubai', name: 'Dubai', offset: '+04:00', region: 'Asia' },
  { id: 'Asia/Karachi', name: 'Karachi', offset: '+05:00', region: 'Asia' },
  { id: 'Asia/Kolkata', name: 'Mumbai / New Delhi', offset: '+05:30', region: 'Asia' },
  { id: 'Asia/Dhaka', name: 'Dhaka', offset: '+06:00', region: 'Asia' },
  { id: 'Asia/Bangkok', name: 'Bangkok', offset: '+07:00', region: 'Asia' },
  { id: 'Asia/Jakarta', name: 'Jakarta', offset: '+07:00', region: 'Asia' },
  { id: 'Asia/Singapore', name: 'Singapore', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Hong_Kong', name: 'Hong Kong', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Shanghai', name: 'Shanghai', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Taipei', name: 'Taipei', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Seoul', name: 'Seoul', offset: '+09:00', region: 'Asia' },
  { id: 'Asia/Tokyo', name: 'Tokyo', offset: '+09:00', region: 'Asia' },
  { id: 'Asia/Manila', name: 'Manila', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Kuala_Lumpur', name: 'Kuala Lumpur', offset: '+08:00', region: 'Asia' },
  { id: 'Asia/Tel_Aviv', name: 'Tel Aviv', offset: '+02:00', region: 'Asia' },
  { id: 'Asia/Riyadh', name: 'Riyadh', offset: '+03:00', region: 'Asia' },

  // Africa
  { id: 'Africa/Cairo', name: 'Cairo', offset: '+02:00', region: 'Africa' },
  { id: 'Africa/Lagos', name: 'Lagos', offset: '+01:00', region: 'Africa' },
  { id: 'Africa/Johannesburg', name: 'Johannesburg', offset: '+02:00', region: 'Africa' },
  { id: 'Africa/Nairobi', name: 'Nairobi', offset: '+03:00', region: 'Africa' },
  { id: 'Africa/Casablanca', name: 'Casablanca', offset: '+01:00', region: 'Africa' },

  // Oceania
  { id: 'Australia/Sydney', name: 'Sydney', offset: '+11:00', region: 'Oceania' },
  { id: 'Australia/Melbourne', name: 'Melbourne', offset: '+11:00', region: 'Oceania' },
  { id: 'Australia/Brisbane', name: 'Brisbane', offset: '+10:00', region: 'Oceania' },
  { id: 'Australia/Perth', name: 'Perth', offset: '+08:00', region: 'Oceania' },
  { id: 'Pacific/Auckland', name: 'Auckland', offset: '+13:00', region: 'Oceania' },
  { id: 'Pacific/Fiji', name: 'Fiji', offset: '+12:00', region: 'Oceania' },
  { id: 'Pacific/Honolulu', name: 'Honolulu', offset: '-10:00', region: 'Oceania' },
];

interface TimezoneSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedTimezone?: string;
  onSelect: (timezone: Timezone) => void;
}

export function TimezoneSelectorDialog({
  open,
  onOpenChange,
  selectedTimezone,
  onSelect,
}: TimezoneSelectorDialogProps) {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');
  const regionLabels: Record<string, string> = {
    Universal: t('sweep.weldcrm.timezoneSelectorDialog.regionUniversal'),
    Americas: t('sweep.weldcrm.timezoneSelectorDialog.regionAmericas'),
    Europe: t('sweep.weldcrm.timezoneSelectorDialog.regionEurope'),
    Asia: t('sweep.weldcrm.timezoneSelectorDialog.regionAsia'),
    Africa: t('sweep.weldcrm.timezoneSelectorDialog.regionAfrica'),
    Oceania: t('sweep.weldcrm.timezoneSelectorDialog.regionOceania'),
  };

  // Filter timezones based on search query
  const filteredTimezones = useMemo(() => {
    if (!searchQuery) return TIMEZONES;
    const query = searchQuery.toLowerCase();
    return TIMEZONES.filter(
      (tz) =>
        tz.name.toLowerCase().includes(query) ||
        tz.id.toLowerCase().includes(query) ||
        tz.region.toLowerCase().includes(query) ||
        tz.offset.includes(query)
    );
  }, [searchQuery]);

  // Group timezones by region
  const groupedTimezones = useMemo(() => {
    const groups: Record<string, Timezone[]> = {};
    filteredTimezones.forEach((tz) => {
      if (!groups[tz.region]) {
        groups[tz.region] = [];
      }
      groups[tz.region].push(tz);
    });
    return groups;
  }, [filteredTimezones]);

  const handleSelect = (timezone: Timezone) => {
    // Pass both name and offset for display
    onSelect({ ...timezone, name: `${timezone.name} (UTC${timezone.offset})` });
    onOpenChange(false);
  };

  // Reset search when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-[672px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            {t('sweep.weldcrm.timezoneSelectorDialog.selectTimezone')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('sweep.weldcrm.timezoneSelectorDialog.searchTimezones')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9"
              autoFocus
            />
          </div>

          {/* Timezones List */}
          <ScrollArea className="h-[320px] -mx-1">
            <div className="space-y-4 px-1">
              {Object.entries(groupedTimezones).map(([region, timezones]) => (
                <div key={region}>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    {regionLabels[region] || region}
                  </p>
                  <div className="space-y-0.5">
                    {timezones.map((timezone) => {
                      const isSelected = selectedTimezone === timezone.id || selectedTimezone === timezone.name;
                      return (
                        <Button
                          key={timezone.id}
                          variant="ghost"
                          onClick={() => handleSelect(timezone)}
                          className="flex w-full items-center gap-3 py-2 text-sm transition-colors hover:opacity-70"
                        >
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 text-left">{timezone.name}</span>
                          <span className="text-xs text-muted-foreground">
                            UTC{timezone.offset}
                          </span>
                          {isSelected && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {filteredTimezones.length === 0 && (
                <div className="py-8 text-center text-muted-foreground">
                  {t('sweep.weldcrm.timezoneSelectorDialog.noTimezonesFound')}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
