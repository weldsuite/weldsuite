/**
 * Searching a list: the search field on top with the filter button beside it,
 * and what a search that finds nothing shows. Expenses (both lists) and
 * Absence → Requests use these, so they look and work the same.
 */

import { StyleSheet, View } from 'react-native';

import { useI18n } from '@/lib/i18n';
import { EmptyState } from './EmptyState';
import { FilterButton } from './FilterButton';
import { Inset } from './Screen';
import { SearchField } from './SearchField';

/** The field and the filter button; `testID` names both ("expenses" → "expenses-search", "expenses-filter"). */
export function ListSearch({
  value,
  onChangeText,
  placeholder,
  filtered,
  onFilter,
  testID,
}: Readonly<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  /** Something is switched off in the filter: the button shows it. */
  filtered: boolean;
  onFilter: () => void;
  testID: string;
}>) {
  const { t } = useI18n();
  return (
    <Inset style={styles.search}>
      <SearchField
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessory={<FilterButton onPress={onFilter} active={filtered} label={t.common.filter} testID={`${testID}-filter`} />}
        testID={`${testID}-search`}
      />
    </Inset>
  );
}

/**
 * What a search that finds nothing shows, with the way back to the whole list:
 * first the filters go, then the search. Right under the field, not centred in
 * the page: while typing, the middle of the page is under the keyboard.
 */
export function NoMatches({
  title,
  description,
  filtered,
  onClearFilters,
  onClearSearch,
}: Readonly<{
  title: string;
  description: string;
  filtered: boolean;
  onClearFilters: () => void;
  onClearSearch: () => void;
}>) {
  const { t } = useI18n();
  const action = filtered
    ? { label: t.common.clearFilters, onPress: onClearFilters }
    : { label: t.common.clearSearch, onPress: onClearSearch };
  return (
    <View>
      <EmptyState illustration="search" title={title} description={description} action={action} />
    </View>
  );
}

const styles = StyleSheet.create({
  search: { marginTop: 12 },
});
