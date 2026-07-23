
import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { useGridContext } from '../context';

interface GridPaginationProps {
  onPageChange: (page: number) => void;
}

export function GridPagination({ onPageChange }: GridPaginationProps) {
  const t = useTranslations();
  const { pagination } = useGridContext();

  if (!pagination) {
    return null;
  }

  const { page, pageSize, totalCount, total, totalPages, hasMore } = pagination;
  const actualTotal = totalCount || total || 0;
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, actualTotal);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-background">
      <div className="text-sm text-muted-foreground">
        {actualTotal > 0 ? (
          <>
            {t('sweep.entities.showingLabel')} <span className="font-medium">{startItem}</span> {t('sweep.entities.toLabel')}{' '}
            <span className="font-medium">{endItem}</span> {t('sweep.entities.ofLabel')}{' '}
            <span className="font-medium">{actualTotal.toLocaleString()}</span> {t('sweep.entities.resultsLabel')}
          </>
        ) : (
          t('sweep.entities.noResults')
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* First page */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 "
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>

        {/* Previous page */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 "
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {/* Page indicator */}
        <div className="flex items-center gap-1 px-2">
          <span className="text-sm font-medium">{page}</span>
          <span className="text-sm text-muted-foreground">{t('sweep.entities.ofLabel')}</span>
          <span className="text-sm font-medium">{totalPages || 1}</span>
        </div>

        {/* Next page */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 "
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || (!hasMore && page >= totalPages)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        {/* Last page */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 "
          onClick={() => onPageChange(totalPages)}
          disabled={page >= totalPages}
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
