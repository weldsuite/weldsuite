import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/form-1099/page';
import { isForm1099Tab, type Form1099Tab } from '@/app/weldbooks/form-1099/form-1099-model';

interface Form1099Search {
  /** Tax year the Center opens on. */
  year?: number;
  tab?: Form1099Tab;
}

export const Route = createFileRoute('/weldbooks/form-1099/')({
  validateSearch: (search: Record<string, unknown>): Form1099Search => {
    const year = Number(search.year);
    return {
      year: Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : undefined,
      tab: isForm1099Tab(search.tab) ? search.tab : undefined,
    };
  },
  component: PageComponent,
});
