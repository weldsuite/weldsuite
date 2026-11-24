import { useId } from 'react';
import { ListingResults, SortForm } from '../components/listing';
import { COLUMN_OPTIONS } from '../components/scheme';
import { useShop } from '../context';
import { sectionSettings } from '../settings';
import { format } from '../strings';
import type { SectionProps } from './types';

/** The search page: the search form, then the results. */
export function MainSearch({ section, attributes }: Readonly<SectionProps>) {
  const { shop, data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const inputId = useId();
  const s = shop.strings.search;
  const listing = data.listing;
  const query = listing?.query ?? '';
  return (
    <section {...attributes} aria-labelledby="search-title" className="shop-container shop-section flex flex-col gap-8">
      <h1 id="search-title" className="text-3xl font-semibold md:text-4xl">
        {s.title}
      </h1>
      <search>
        <form action="/search" method="get" className="flex max-w-xl flex-col gap-2">
          <label htmlFor={inputId} className="shop-label">
            {s.prompt}
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="search"
              name="q"
              defaultValue={query}
              maxLength={100}
              enterKeyHint="search"
              autoComplete="off"
              className="shop-input flex-1"
            />
            <button type="submit" className="shop-btn shop-btn-primary">
              {s.submit}
            </button>
          </div>
        </form>
      </search>
      {listing && query ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="text-xl font-semibold" aria-live="polite">
              {format(s.resultsFor, { query })}
            </h2>
            {listing.products.length > 1 ? <SortForm listing={listing} /> : null}
          </div>
          <ListingResults listing={listing} columns={settings.choice('columns', COLUMN_OPTIONS)} emptyText={format(s.noResults, { query })} cardHeadingLevel={3} />
        </div>
      ) : null}
    </section>
  );
}
