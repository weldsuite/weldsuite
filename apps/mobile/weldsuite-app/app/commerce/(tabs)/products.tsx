import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  Image,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import api, { Product as ApiProduct, ProductStats } from '@/services/api';
import { useToast } from '@/contexts/ToastContext';

interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  featuredImageUrl?: string;
  quantityAvailable: number;
  categoryName?: string;
  sku: string;
  status: 'active' | 'draft' | 'archived';
}

export default function ProductsAdminScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [totalProducts, setTotalProducts] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [bulkActionModalVisible, setBulkActionModalVisible] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [stats, setStats] = useState<ProductStats>({ total: 0, active: 0, draft: 0, archived: 0 });

  useEffect(() => {
    loadProducts();
    loadStats();
  }, []);

  // Debounced search effect
  useEffect(() => {
    // Skip on initial mount
    if (initialLoading) return;

    const timeoutId = setTimeout(() => {
      setCurrentPage(1);
      setHasMore(true);
      loadProducts(1, false, statusFilter, true);
    }, 500); // 500ms debounce

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    filterProducts();
  }, [selectedCategory, products]);

  const loadProducts = async (page: number = 1, append: boolean = false, status?: string, isFilterChange: boolean = false) => {
    try {
      if (isFilterChange) {
        setFilterLoading(true);
      } else if (append) {
        setLoadingMore(true);
      }

      // Prepare API parameters
      const params: any = {
        page: page,
        limit: 25, // Load 25 products at a time
        sortBy: 'created',
        sortOrder: 'desc'
      };

      // Add status filter if not 'all'
      const filterStatus = status || statusFilter;
      if (filterStatus && filterStatus !== 'all') {
        params.status = filterStatus;
      }

      // Add search query if present
      if (searchQuery) {
        params.search = searchQuery;
      }

      // Call the real API
      const response = await api.getProducts(params);

      if (response.success && response.data) {
        // The API returns "items" not "products"
        const productsArray = response.data.items || response.data.products || [];

        // Transform API products to match local interface
        const transformedProducts: Product[] = productsArray.map((p: ApiProduct) => ({
          id: p.id,
          title: p.name,
          description: p.shortDescription || '',
          price: p.price.amount,
          compareAtPrice: p.compareAtPrice?.amount,
          featuredImageUrl: p.thumbnailUrl,
          quantityAvailable: p.stock || 0,
          categoryName: p.categoryName,
          sku: p.sku,
          status: p.status === 'active' ? 'active' : 'draft',
        }));

        // Get total count and pagination info from API metadata
        const total = response.data.meta?.total || 0;
        const hasNext = response.data.meta?.hasNext || false;

        if (append) {
          // Append new products to existing ones
          setProducts(prev => [...prev, ...transformedProducts]);
          setFilteredProducts(prev => [...prev, ...transformedProducts]);
        } else {
          // Replace products (initial load or refresh)
          setProducts(transformedProducts);
          setFilteredProducts(transformedProducts);
        }

        setTotalProducts(total);
        setHasMore(hasNext);
        setCurrentPage(page);
      } else {
        throw new Error(response.error || 'Failed to load products');
      }
    } catch (error) {
      console.error('Error loading products:', error);
      toast.error(
        error instanceof Error ? error.message : 'Failed to load products. Make sure the API is running.'
      );
      // Keep existing products on error
    } finally {
      setInitialLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      setFilterLoading(false);
    }
  };

  const loadMoreProducts = () => {
    if (!loadingMore && hasMore) {
      const nextPage = currentPage + 1;
      loadProducts(nextPage, true);
    }
  };

  const loadStats = async () => {
    try {
      const response = await api.getProductStats();
      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch (error) {
      console.error('Error loading product stats:', error);
    }
  };

  const filterProducts = () => {
    let filtered = [...products];

    // Note: Search filter is now handled server-side in loadProducts() with debouncing
    // Note: Status filter is now handled server-side in loadProducts()

    // Category filter (local - keeping this local for now)
    if (selectedCategory && selectedCategory !== 'all') {
      filtered = filtered.filter((p) => p.categoryName === selectedCategory);
    }

    setFilteredProducts(filtered);
  };

  const handleStatusFilterChange = (newStatus: string) => {
    setStatusFilter(newStatus);
    setCurrentPage(1);
    setHasMore(true);
    loadProducts(1, false, newStatus, true);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setCurrentPage(1);
    setHasMore(true);
    loadProducts(1, false);
    loadStats();
  };

  const handleProductPress = (productId: string) => {
    router.push(`/product/edit/${productId}` as any);
  };

  const handleDeleteProduct = (productId: string) => {
    setProducts(products.filter(p => p.id !== productId));
    toast.success('Product deleted successfully');
  };

  const handleToggleProductSelection = (productId: string) => {
    setSelectedProducts(prev =>
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    );
  };

  const handleBulkAction = (action: string) => {
    setBulkActionModalVisible(false);

    switch (action) {
      case 'activate':
        setProducts(products.map(p =>
          selectedProducts.includes(p.id) ? { ...p, status: 'active' as const } : p
        ));
        toast.success(`${selectedProducts.length} products activated`);
        break;
      case 'deactivate':
        setProducts(products.map(p =>
          selectedProducts.includes(p.id) ? { ...p, status: 'draft' as const } : p
        ));
        toast.success(`${selectedProducts.length} products deactivated`);
        break;
      case 'delete':
        setProducts(products.filter(p => !selectedProducts.includes(p.id)));
        setSelectedProducts([]);
        toast.success('Products deleted successfully');
        return;
    }

    setSelectedProducts([]);
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'active': return 'ACTIVE';
      case 'draft': return 'DRAFT';
      case 'archived': return 'ARCHIVED';
      default: return status.toUpperCase();
    }
  };

  const getStockText = (quantity: number) => {
    if (quantity === 0) return 'OUT OF STOCK';
    if (quantity < 10) return 'LOW STOCK';
    return 'IN STOCK';
  };

  const renderProduct = ({ item }: { item: Product }) => {
    const isSelected = selectedProducts.includes(item.id);
    const hasImage = item.featuredImageUrl && item.featuredImageUrl !== '';
    const stockStatus = getStockText(item.quantityAvailable);
    const stockColor = item.quantityAvailable === 0 ? '#DC2626' : item.quantityAvailable < 10 ? '#EA580C' : '#16A34A';
    const stockBgColor = item.quantityAvailable === 0 ? '#FEF2F2' : item.quantityAvailable < 10 ? '#FFF7ED' : '#F0FDF4';

    return (
      <TouchableOpacity
        style={[
          styles.productCard, 
          { 
            backgroundColor: isSelected ? '#F9FAFB' : colors.background, 
            borderBottomColor: colors.divider 
          }
        ]}
        onPress={() => selectionMode ? handleToggleProductSelection(item.id) : handleProductPress(item.id)}
        activeOpacity={0.7}
      >
        <View style={styles.productCardContent}>
          {/* Selection Checkbox */}
          {selectionMode && (
            <TouchableOpacity
              style={styles.checkboxContainer}
              onPress={() => handleToggleProductSelection(item.id)}
            >
              <View style={[
                styles.checkbox,
                { 
                  borderColor: isSelected ? colors.text : colors.divider,
                  backgroundColor: isSelected ? colors.text : 'transparent'
                }
              ]}>
                {isSelected && <Ionicons name="checkmark" size={12} color={colors.background} />}
              </View>
            </TouchableOpacity>
          )}
          
          {/* Product Image or Placeholder */}
          <View style={[styles.productImageContainer, { backgroundColor: hasImage ? 'transparent' : '#F3F4F6' }]}>
            {hasImage ? (
              <Image source={{ uri: item.featuredImageUrl }} style={styles.productImage} />
            ) : (
              <Ionicons name="image-outline" size={22} color="#9CA3AF" />
            )}
          </View>

          {/* Product Info */}
          <View style={styles.productInfo}>
            <View>
              <View style={styles.productHeader}>
                <Text style={[styles.productTitle, { color: colors.text }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <View style={[
                  styles.stockBadge,
                  { backgroundColor: stockBgColor }
                ]}>
                  <View style={[styles.stockDot, { backgroundColor: stockColor }]} />
                  <Text style={[styles.stockText, { color: stockColor }]}>
                    {item.quantityAvailable}
                  </Text>
                </View>
              </View>
              <Text style={[styles.productCategory, { color: colors.muted }]}>
                {item.categoryName || 'Uncategorized'} · SKU: {item.sku}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (initialLoading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading products...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Products</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity
            style={[styles.selectButton, { borderColor: colors.buttonBorder }]}
            onPress={() => {
              setSelectionMode(!selectionMode);
              if (selectionMode) {
                setSelectedProducts([]);
              }
            }}
          >
            <Text style={[styles.selectButtonText, { color: colors.text }]}>
              {selectionMode ? 'Cancel' : 'Select'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.addButton, { borderColor: colors.buttonBorder }]}
            onPress={() => router.push('/product/new' as any)}
          >
            <Ionicons name="add" size={16} color={colors.text} />
            <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search products, SKU..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery && !filterLoading && (
            <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearButton}>
              <Ionicons name="close-circle" size={16} color={colors.muted} />
            </TouchableOpacity>
          )}
          {filterLoading && searchQuery && (
            <ActivityIndicator size="small" color={colors.muted} />
          )}
        </View>
      </View>

      {/* Filters */}
      <View style={[styles.filtersContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          {[
            { key: 'all', label: 'All Products', count: stats.total },
            { key: 'active', label: 'Active', count: stats.active },
            { key: 'draft', label: 'Draft', count: stats.draft },
            { key: 'archived', label: 'Archived', count: stats.archived },
          ].map((item) => (
            <TouchableOpacity
              key={item.key}
              style={[
                styles.filterOption,
                {
                  backgroundColor: statusFilter === item.key ? colors.text : colors.background,
                  borderColor: statusFilter === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => handleStatusFilterChange(item.key)}
            >
              <Text
                style={[
                  styles.filterOptionText,
                  { color: statusFilter === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterOptionCount,
                  { color: statusFilter === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Bulk Actions */}
      {selectionMode && (
        <View style={[styles.bulkActionsContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
          <Text style={[styles.bulkActionsText, { color: colors.text }]}>
            {selectedProducts.length || 0} selected
          </Text>
          <TouchableOpacity
            style={styles.bulkActionsButton}
            onPress={() => setBulkActionModalVisible(true)}
          >
            <Text style={[styles.bulkActionsButtonText, { color: colors.text }]}>Actions</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Products List */}
      {filterLoading ? (
        <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading products...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredProducts}
          renderItem={renderProduct}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContainer}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          onEndReached={loadMoreProducts}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={colors.text} />
                <Text style={[styles.footerText, { color: colors.muted }]}>Loading more products...</Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>No products found</Text>
              <TouchableOpacity
                style={[styles.emptyButton, { borderColor: colors.divider }]}
                onPress={() => router.push('/product/new' as any)}
              >
                <Text style={[styles.emptyButtonText, { color: colors.text }]}>Add Product</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}

      {/* Bulk Actions Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={bulkActionModalVisible}
        onRequestClose={() => setBulkActionModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Actions</Text>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={() => handleBulkAction('activate')}
            >
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Activate Products</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={() => handleBulkAction('deactivate')}
            >
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Deactivate Products</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalOption, { borderBottomColor: colors.divider }]}
              onPress={() => handleBulkAction('delete')}
            >
              <Text style={[styles.modalOptionText, { color: colors.text }]}>Delete Products</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalCancel, { borderTopColor: colors.divider }]}
              onPress={() => setBulkActionModalVisible(false)}
            >
              <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  selectButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  searchContainer: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  clearButton: {
    padding: 4,
  },
  filtersContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 24,
  },
  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterOptionCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  bulkActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  bulkActionsText: {
    fontSize: 10,
    fontWeight: '400',
  },
  bulkActionsButton: {
    padding: 4,
  },
  bulkActionsButtonText: {
    fontSize: 10,
    fontWeight: '400',
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  productCard: {
    borderBottomWidth: 0.5,
    position: 'relative',
  },
  productCardContent: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  productImageContainer: {
    width: 58,
    height: 58,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  productImage: {
    width: '100%',
    height: '100%',
    borderRadius: 6,
    resizeMode: 'cover',
  },
  productInfo: {
    flex: 1,
    justifyContent: 'space-between',
  },
  productHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 2,
  },
  productTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
    flex: 1,
    paddingRight: 8,
  },
  productCategory: {
    fontSize: 12,
    marginBottom: 4,
  },
  productFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  stockDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  stockText: {
    fontSize: 12,
    fontWeight: '500',
  },
  productSku: {
    fontSize: 11,
  },
  checkboxContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 12,
    marginBottom: 24,
  },
  emptyButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderWidth: 0.5,
    borderRadius: 2,
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '400',
  },
  footerLoader: {
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  footerText: {
    fontSize: 12,
    marginTop: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    padding: 24,
    borderTopWidth: 0.5,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '400',
    textAlign: 'center',
    marginBottom: 24,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  modalOption: {
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalOptionText: {
    fontSize: 16,
    fontWeight: '400',
  },
  modalCancel: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    borderTopWidth: 0.5,
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '400',
  },
});