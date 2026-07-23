import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { Search, ShoppingCart, Settings2, ChevronLeft } from 'lucide-react-native';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import { useToast } from '@/contexts/ToastContext';

interface DomainResult {
  domain: string;
  tld: string;
  available: boolean;
  price: number;
}

const TLDS = ['.com', '.net', '.org', '.io', '.dev', '.app', '.ai', '.tech', '.co', '.biz', '.info', '.pro', '.company', '.ltd', '.xyz', '.online', '.store', '.site', '.shop'];

export default function RegisterDomainScreen() {
  const { colors } = useTheme();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { onScroll, resetHeader } = useCollapsibleHeader();
  const toast = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DomainResult[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<DomainResult[]>([]);

  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  const searchDomains = async () => {
    if (searchQuery.trim().length < 2) return;

    setSearching(true);

    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 800));

    const baseName = searchQuery.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const mockResults: DomainResult[] = TLDS.map((tld) => ({
      domain: `${baseName}${tld}`,
      tld: tld,
      available: Math.random() > 0.6,
      price: tld === '.com' ? 12.99 : tld === '.io' ? 39.99 : tld === '.ai' ? 79.99 : 14.99,
    }));

    setResults(mockResults);
    setSearching(false);
  };

  const toggleDomainSelection = (domain: DomainResult) => {
    if (!domain.available) return;

    setSelectedDomains(prev => {
      const exists = prev.find(d => d.domain === domain.domain);
      if (exists) {
        return prev.filter(d => d.domain !== domain.domain);
      }
      return [...prev, domain];
    });
  };

  const isSelected = (domain: DomainResult) => {
    return selectedDomains.some(d => d.domain === domain.domain);
  };

  const getTotalPrice = () => {
    return selectedDomains.reduce((sum, d) => sum + d.price, 0);
  };

  const handleCheckout = () => {
    if (selectedDomains.length === 0) {
      toast.error('Please select at least one domain');
      return;
    }
    toast.info(`Proceeding to checkout with ${selectedDomains.length} domain(s)`);
  };

  const renderDomainItem = ({ item, index }: { item: DomainResult; index: number }) => {
    const selected = isSelected(item);
    const isFirst = index === 0;

    return (
      <TouchableOpacity
        style={[
          styles.domainItem,
          {
            borderBottomColor: colors.divider,
            backgroundColor: selected ? '#F0F7FF' : colors.background,
          },
          isFirst && styles.domainItemFirst,
        ]}
        onPress={() => toggleDomainSelection(item)}
        disabled={!item.available}
        activeOpacity={0.7}
      >
        <Text style={[
          styles.domainName,
          { color: item.available ? colors.text : colors.muted }
        ]}>
          {item.domain}
        </Text>
        <View style={styles.domainRight}>
          {item.available ? (
            <>
              <Text style={[styles.priceText, { color: colors.text }]}>
                US$ {item.price.toFixed(2).replace('.', ',')}
              </Text>
              <TouchableOpacity
                style={[
                  styles.cartButton,
                  { backgroundColor: selected ? '#3B82F6' : '#1F2937' }
                ]}
                onPress={() => toggleDomainSelection(item)}
              >
                <ShoppingCart
                  size={16}
                  color="#FFFFFF"
                  strokeWidth={2}
                />
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={[styles.unavailableText, { color: colors.muted }]}>
                Unavailable
              </Text>
              <View style={[styles.cartButton, { backgroundColor: '#F3F4F6' }]}>
                {isFirst ? (
                  <Settings2 size={16} color="#9CA3AF" strokeWidth={2} />
                ) : (
                  <ShoppingCart size={16} color="#9CA3AF" strokeWidth={2} />
                )}
              </View>
            </>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>
        Search for a domain to see availability
      </Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            setSearchQuery('');
            setResults([]);
            setSelectedDomains([]);
          }}
        >
          <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Register a New Domain</Text>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background }]}>
        <View style={[styles.searchBar, { borderColor: colors.divider }]}>
          <Search size={16} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search domain..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={(text) => {
              setSearchQuery(text);
              if (text.trim().length >= 2) {
                // Debounce search
                setTimeout(() => searchDomains(), 300);
              }
            }}
            onSubmitEditing={searchDomains}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searching && <ActivityIndicator size="small" color={colors.muted} />}
        </View>
      </View>

      {/* Results List */}
      <FlatList
        data={results}
        renderItem={renderDomainItem}
        keyExtractor={(item) => item.domain}
        style={styles.listContainer}
        contentContainerStyle={results.length === 0 ? styles.emptyList : undefined}
        onScroll={!showMiniSidebar ? onScroll : undefined}
        scrollEventThrottle={16}
        ListEmptyComponent={!searching ? renderEmptyState : null}
        showsVerticalScrollIndicator={false}
      />

      {/* Bottom Summary */}
      <View style={[styles.summaryContainer, { backgroundColor: colors.background, borderTopColor: colors.divider }]}>
        <View style={styles.summaryRow}>
          <Text style={[styles.summaryLabel, { color: colors.text }]}>Total</Text>
          <Text style={[styles.summaryValue, { color: colors.text }]}>
            US$ {getTotalPrice().toFixed(2).replace('.', ',')}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.checkoutButton,
            { backgroundColor: selectedDomains.length > 0 ? '#1F2937' : '#E5E7EB' }
          ]}
          onPress={handleCheckout}
          disabled={selectedDomains.length === 0}
        >
          <Text style={[
            styles.checkoutButtonText,
            { color: selectedDomains.length > 0 ? '#FFFFFF' : '#9CA3AF' }
          ]}>
            Proceed to Payment
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 12,
  },
  backButton: {
    padding: 4,
    marginRight: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  listContainer: {
    flex: 1,
  },
  emptyList: {
    flex: 1,
  },
  domainItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  domainItemFirst: {},
  domainName: {
    fontSize: 15,
    fontWeight: '400',
  },
  domainRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  priceText: {
    fontSize: 13,
    fontWeight: '500',
  },
  unavailableText: {
    fontSize: 13,
    fontWeight: '400',
  },
  cartButton: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 14,
  },
  summaryContainer: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
    gap: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  summaryValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  checkoutButton: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  checkoutButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
