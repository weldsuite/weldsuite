
import { useState, useEffect } from 'react';
import { Building, Plus, Search, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { useTranslations } from '@weldsuite/i18n/client';

export interface Company {
  id: string;
  name: string;
}

interface CompanySelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
  selectedCompany?: string;
  onSelect: (company: Company) => void;
  onCreate: (name: string) => void;
  isLoading?: boolean;
}

export function CompanySelectorDialog({
  open,
  onOpenChange,
  companies,
  selectedCompany,
  onSelect,
  onCreate,
  isLoading,
}: CompanySelectorDialogProps) {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Filter companies based on search query
  const filteredCompanies = companies.filter((company) =>
    company.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Check if the search query matches an existing company name exactly
  const exactMatch = companies.some(
    (company) => company.name.toLowerCase() === searchQuery.toLowerCase()
  );

  const handleCreate = () => {
    if (searchQuery.trim() && !exactMatch) {
      setIsCreating(true);
      onCreate(searchQuery.trim());
      setSearchQuery('');
      setIsCreating(false);
      onOpenChange(false);
    }
  };

  const handleSelect = (company: Company) => {
    onSelect(company);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building className="h-5 w-5" />
            {t('sweep.weldcrm.companySelectorDialog.selectCompany')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('sweep.weldcrm.companySelectorDialog.searchOrCreatePlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          {/* Companies List */}
          <ScrollArea className="h-[240px]">
            <div className="space-y-1">
              {isLoading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  {t('sweep.weldcrm.companySelectorDialog.loadingCompanies')}
                </div>
              ) : filteredCompanies.length > 0 ? (
                filteredCompanies.map((company) => (
                  <Button
                    key={company.id}
                    variant="ghost"
                    onClick={() => handleSelect(company)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors"
                  >
                    <Building className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 text-left">{company.name}</span>
                    {selectedCompany === company.name && (
                      <Check className="h-4 w-4 text-primary" />
                    )}
                  </Button>
                ))
              ) : searchQuery ? (
                <div className="py-8 text-center text-muted-foreground">
                  {t('sweep.weldcrm.companySelectorDialog.noCompaniesFound')}
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  {t('sweep.weldcrm.companySelectorDialog.noCompaniesYet')}
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Create New Company */}
          {searchQuery.trim() && !exactMatch && (
            <div className="border-t pt-4">
              <Button
                onClick={handleCreate}
                disabled={isCreating}
                variant="outline"
                className="w-full justify-start gap-2"
              >
                <Plus className="h-4 w-4" />
                {t('sweep.weldcrm.companySelectorDialog.createNamed', { name: searchQuery.trim() })}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
