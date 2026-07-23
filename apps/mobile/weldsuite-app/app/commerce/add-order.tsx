import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
  Animated,
  Easing,
  TouchableWithoutFeedback,
  Keyboard,
  ActivityIndicator,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { ChevronLeft, Plus, Trash2, Search, X, Check } from 'lucide-react-native';
import api, { Customer, Product } from '@/services/api';

interface OrderItem {
  id: string;
  productId?: string;
  productName: string;
  sku?: string;
  quantity: number;
  price: number;
}

export default function AddOrderScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [currentItemIndex, setCurrentItemIndex] = useState<number | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [items, setItems] = useState<OrderItem[]>([
    { id: '1', productName: '', quantity: 1, price: 0 }
  ]);
  const [notes, setNotes] = useState('');

  // Loading states
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);

  // Data lists
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  // Animation values for stacked page effect
  const slideAnim = useRef(new Animated.Value(1000)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const productSlideAnim = useRef(new Animated.Value(1000)).current;
  const productFadeAnim = useRef(new Animated.Value(0)).current;
  const productScaleAnim = useRef(new Animated.Value(1)).current;
  
  // Fetch customers when search changes
  useEffect(() => {
    if (showCustomerModal) {
      fetchCustomers();
    }
  }, [customerSearch, showCustomerModal]);

  // Fetch products when search changes
  useEffect(() => {
    if (showProductModal) {
      fetchProducts();
    }
  }, [productSearch, showProductModal]);

  // Fetch customers from API
  const fetchCustomers = async () => {
    setLoadingCustomers(true);
    try {
      const response = await api.getCustomers({
        search: customerSearch,
        page: 1,
        limit: 20,
        accountStatus: 'active',
      });

      if (response.success && response.data) {
        setCustomers(response.data.items);
      } else {
        toast.error(response.error || 'Failed to load customers');
      }
    } catch (error) {
      console.error('Error fetching customers:', error);
      toast.error('Failed to load customers');
    } finally {
      setLoadingCustomers(false);
    }
  };

  // Fetch products from API
  const fetchProducts = async () => {
    setLoadingProducts(true);
    try {
      const response = await api.getProducts({
        search: productSearch,
        page: 1,
        limit: 20,
        status: 'active',
        inStockOnly: true,
      });

      if (response.success && response.data) {
        // Handle both response formats (items or products)
        const productList = response.data.items || response.data.products || [];
        setProducts(productList);
      } else {
        toast.error(response.error || 'Failed to load products');
      }
    } catch (error) {
      console.error('Error fetching products:', error);
      toast.error('Failed to load products');
    } finally {
      setLoadingProducts(false);
    }
  };

  // Handle modal animations for customer modal
  useEffect(() => {
    if (showCustomerModal) {
      // Animate in
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.95,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start();
    } else {
      // Animate out
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 1000,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start(() => {
        // Reset values after close
        slideAnim.setValue(1000);
        fadeAnim.setValue(0);
        scaleAnim.setValue(1);
      });
    }
  }, [showCustomerModal]);

  // Handle modal animations for product modal
  useEffect(() => {
    if (showProductModal) {
      // Animate in
      Animated.parallel([
        Animated.timing(productSlideAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(productFadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(productScaleAnim, {
          toValue: 0.95,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start();
    } else {
      // Animate out
      Animated.parallel([
        Animated.timing(productSlideAnim, {
          toValue: 1000,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(productFadeAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(productScaleAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start(() => {
        // Reset values after close
        productSlideAnim.setValue(1000);
        productFadeAnim.setValue(0);
        productScaleAnim.setValue(1);
      });
    }
  }, [showProductModal]);

  const addItem = () => {
    const newItem: OrderItem = {
      id: Date.now().toString(),
      productName: '',
      quantity: 1,
      price: 0
    };
    setItems([...items, newItem]);
  };

  const removeItem = (id: string) => {
    if (items.length > 1) {
      setItems(items.filter(item => item.id !== id));
    }
  };

  const updateItem = (id: string, field: keyof OrderItem, value: string | number) => {
    setItems(items.map(item =>
      item.id === id ? { ...item, [field]: value } : item
    ));
  };

  const calculateSubtotal = () => {
    return items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  };

  const calculateTax = (subtotal: number) => {
    return subtotal * 0.1; // 10% tax rate
  };

  const calculateTotal = () => {
    const subtotal = calculateSubtotal();
    const tax = calculateTax(subtotal);
    return subtotal + tax;
  };

  const handleCreateOrder = async () => {
    if (!selectedCustomer) {
      toast.error('Please select a customer');
      return;
    }

    // For now, accept manual product entry without productId
    // TODO: Implement product selection modal for better UX
    const hasValidItems = items.some(item => item.productName.trim() && item.quantity > 0 && item.price > 0);
    if (!hasValidItems) {
      toast.error('Please add at least one valid product with name, quantity, and price');
      return;
    }

    try {
      setCreatingOrder(true);

      const subtotal = calculateSubtotal();
      const tax = calculateTax(subtotal);
      const total = subtotal + tax;

      // Transform items to API format
      // Note: If productId is not set, the API may need to handle product creation/lookup
      const orderItems = items
        .filter(item => item.productName.trim() && item.quantity > 0)
        .map(item => ({
          productId: item.productId || `temp-${Date.now()}-${Math.random()}`, // Temporary ID if not selected from catalog
          quantity: item.quantity,
          price: item.price,
          productName: item.productName, // Include name for reference
        } as any));

      const orderData = {
        customerId: selectedCustomer.id,
        items: orderItems,
        shippingAddress: shippingAddress || undefined,
        notes: notes || undefined,
        subtotal,
        tax,
        total,
      };

      const response = await api.createCommerceOrder(orderData);

      if (response.success) {
        toast.success('Order created successfully!');
        router.back();
      } else {
        toast.error(response.error || 'Failed to create order');
      }
    } catch (error) {
      console.error('Error creating order:', error);
      toast.error('Failed to create order');
    } finally {
      setCreatingOrder(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerStyle: {
            backgroundColor: colors.background,
          },
          headerTitle: 'New Order',
          headerTitleStyle: {
            color: colors.text,
            fontSize: 17,
            fontWeight: '600',
          },
          headerLeft: () => (
            <TouchableOpacity
              onPress={() => router.back()}
              style={{ marginLeft: 8 }}
            >
              <ChevronLeft size={24} color={colors.text} />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              onPress={handleCreateOrder}
              style={{ marginRight: 16 }}
              disabled={creatingOrder}
            >
              {creatingOrder ? (
                <ActivityIndicator size="small" color="#007AFF" />
              ) : (
                <Text style={{ color: '#007AFF', fontSize: 16, fontWeight: '600' }}>
                  Create
                </Text>
              )}
            </TouchableOpacity>
          ),
        }}
      />

      <KeyboardAvoidingView 
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView 
          style={[styles.container, { backgroundColor: colors.background }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Customer Selection Section */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Customer
            </Text>
            
            <TouchableOpacity 
              style={[styles.customerSelectButton, { backgroundColor: selectedCustomer ? '#F9FAFB' : colors.cardBg }]}
              onPress={() => setShowCustomerModal(true)}
            >
              {selectedCustomer ? (
                <>
                  <View style={styles.customerInfo}>
                    <View style={[styles.customerAvatar, { backgroundColor: '#9CA3AF' }]}>
                      <Text style={styles.avatarText}>{selectedCustomer.name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.customerDetails}>
                      <Text style={[styles.customerName, { color: '#374151' }]}>
                        {selectedCustomer.name}
                      </Text>
                      <Text style={[styles.customerEmail, { color: '#6B7280' }]}>
                        {selectedCustomer.email}
                      </Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
                </>
              ) : (
                <View style={styles.emptyCustomerContent}>
                  <Text style={[styles.selectCustomerText, { color: colors.muted }]}>
                    Select a customer
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Shipping Address Section */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Shipping Address
            </Text>
            
            <View style={[styles.inputContainer, { backgroundColor: colors.cardBg, minHeight: 60 }]}>
              <TextInput
                style={[styles.input, { color: colors.text, textAlignVertical: 'top' }]}
                placeholder="Enter shipping address..."
                placeholderTextColor={colors.muted}
                value={shippingAddress}
                onChangeText={setShippingAddress}
                multiline
                numberOfLines={2}
              />
            </View>
          </View>

          {/* Order Items Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>
                Order Items
              </Text>
              <TouchableOpacity
                onPress={addItem}
                style={[styles.addButton, { backgroundColor: colors.text }]}
              >
                <Plus size={16} color={colors.background} />
                <Text style={[styles.addButtonText, { color: colors.background }]}>
                  Add Item
                </Text>
              </TouchableOpacity>
            </View>

            {items.map((item, index) => (
              <View 
                key={item.id} 
                style={[styles.itemCard, { backgroundColor: colors.cardBg }]}
              >
                <View style={styles.itemHeader}>
                  <Text style={[styles.itemNumber, { color: colors.muted }]}>
                    Item #{index + 1}
                  </Text>
                  {items.length > 1 && (
                    <TouchableOpacity
                      onPress={() => removeItem(item.id)}
                      style={styles.removeButton}
                    >
                      <Trash2 size={18} color="#FF3B30" />
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.itemInputs}>
                  <TextInput
                    style={[styles.itemInput, { color: colors.text, flex: 2 }]}
                    placeholder="Product name"
                    placeholderTextColor={colors.muted}
                    value={item.productName}
                    onChangeText={(text) => updateItem(item.id, 'productName', text)}
                  />
                  
                  <TextInput
                    style={[styles.itemInput, { color: colors.text, flex: 1 }]}
                    placeholder="Qty"
                    placeholderTextColor={colors.muted}
                    value={item.quantity.toString()}
                    onChangeText={(text) => updateItem(item.id, 'quantity', parseInt(text) || 0)}
                    keyboardType="numeric"
                  />
                  
                  <TextInput
                    style={[styles.itemInput, { color: colors.text, flex: 1 }]}
                    placeholder="Price"
                    placeholderTextColor={colors.muted}
                    value={item.price.toString()}
                    onChangeText={(text) => updateItem(item.id, 'price', parseFloat(text) || 0)}
                    keyboardType="decimal-pad"
                  />
                </View>
              </View>
            ))}
          </View>

          {/* Notes Section */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              Order Notes
            </Text>
            
            <View style={[styles.inputContainer, { backgroundColor: colors.cardBg, minHeight: 70 }]}>
              <TextInput
                style={[styles.input, { color: colors.text, textAlignVertical: 'top' }]}
                placeholder="Add any special instructions or notes..."
                placeholderTextColor={colors.muted}
                value={notes}
                onChangeText={setNotes}
                multiline
                numberOfLines={2}
              />
            </View>
          </View>

          {/* Total Section */}
          <View style={[styles.totalSection, { backgroundColor: colors.cardBg }]}>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Subtotal</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>
                ${calculateTotal().toFixed(2)}
              </Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>Tax</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>
                ${(calculateTotal() * 0.1).toFixed(2)}
              </Text>
            </View>
            <View style={[styles.totalRow, styles.totalRowFinal]}>
              <Text style={[styles.totalLabelFinal, { color: colors.text }]}>Total</Text>
              <Text style={[styles.totalValueFinal, { color: colors.text }]}>
                ${(calculateTotal() * 1.1).toFixed(2)}
              </Text>
            </View>
          </View>

          <View style={{ height: 20 }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Customer Selection Modal - Stacked Page Style */}
      <Modal
        animationType="none"
        transparent={true}
        visible={showCustomerModal}
        onRequestClose={() => setShowCustomerModal(false)}
        presentationStyle="overFullScreen"
      >
        <Animated.View style={[styles.modalStack, { opacity: fadeAnim }]}>
          {/* Previous page scaled and pushed back */}
          <View style={styles.previousPageContainer}>
            <Animated.View style={[
              styles.previousPage, 
              { 
                backgroundColor: colors.background,
                transform: [{ scale: scaleAnim }],
              }
            ]}>
              <View style={styles.previousPageHeader}>
                <View style={styles.previousPageNotch} />
              </View>
            </Animated.View>
          </View>
          
          {/* Customer Selection Container */}
          <Animated.View 
            style={[
              styles.customerContainer, 
              { 
                backgroundColor: colors.background,
                transform: [{ translateY: slideAnim }]
              }
            ]}
          >
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={{ flex: 1 }}>
                {/* Modal Header */}
                <View style={[styles.modalHeader, { backgroundColor: colors.background }]}>
                  <TouchableOpacity 
                    onPress={() => setShowCustomerModal(false)}
                    style={styles.closeChevron}
                  >
                    <ChevronLeft size={24} color={colors.muted} strokeWidth={2} />
                  </TouchableOpacity>
                  <Text style={[styles.modalTitle, { color: colors.text }]}>
                    Select Customer
                  </Text>
                  <View style={{ width: 32 }} />
                </View>

                {/* Search Bar */}
                <View style={styles.searchContainer}>
                  <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
                    <Search size={16} color={colors.muted} />
                    <TextInput
                      style={[styles.searchInput, { color: colors.text }]}
                      placeholder="Search customers..."
                      placeholderTextColor={colors.muted}
                      value={customerSearch}
                      onChangeText={setCustomerSearch}
                    />
                  </View>
                </View>

                {/* Customer List */}
                {loadingCustomers ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.tint} />
                  </View>
                ) : (
                  <FlatList
              data={customers}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>
                    {customerSearch ? 'No customers found' : 'Search for customers'}
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.customerCard,
                    { 
                      backgroundColor: selectedCustomer?.id === item.id ? '#F3F4F6' : colors.cardBg,
                    }
                  ]}
                  onPress={() => {
                    setSelectedCustomer(item);
                    setShowCustomerModal(false);
                    setCustomerSearch('');
                  }}
                >
                  <View style={styles.customerCardContent}>
                    <View style={[styles.customerModalAvatar, { backgroundColor: '#9CA3AF' }]}>
                      <Text style={styles.modalAvatarText}>{item.name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.customerModalDetails}>
                      <Text style={[styles.customerModalName, { color: '#374151' }]}>
                        {item.name}
                      </Text>
                      <Text style={[styles.customerModalEmail, { color: '#6B7280' }]}>
                        {item.email}
                      </Text>
                    </View>
                    {selectedCustomer?.id === item.id && (
                      <Check size={18} color="#6B7280" />
                    )}
                  </View>
                </TouchableOpacity>
              )}
              contentContainerStyle={styles.customerList}
              showsVerticalScrollIndicator={false}
            />
                )}
              </View>
            </TouchableWithoutFeedback>
          </Animated.View>
        </Animated.View>
      </Modal>

    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  inputContainer: {
    borderRadius: 10,
    marginBottom: 4,
    padding: 10,
  },
  input: {
    fontSize: 16,
  },
  customerSelectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 10,
  },
  customerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  customerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  customerDetails: {
    flex: 1,
  },
  customerName: {
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 2,
  },
  customerEmail: {
    fontSize: 13,
    fontWeight: '400',
  },
  emptyCustomerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
  },
  selectCustomerText: {
    fontSize: 16,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  itemCard: {
    borderRadius: 10,
    padding: 8,
    marginBottom: 6,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  itemNumber: {
    fontSize: 14,
    fontWeight: '500',
  },
  removeButton: {
    padding: 4,
  },
  itemInputs: {
    flexDirection: 'row',
    gap: 8,
  },
  itemInput: {
    fontSize: 14,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  totalSection: {
    marginHorizontal: 12,
    marginVertical: 6,
    padding: 10,
    borderRadius: 10,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  totalRowFinal: {
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  totalLabel: {
    fontSize: 14,
  },
  totalValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  totalLabelFinal: {
    fontSize: 16,
    fontWeight: '600',
  },
  totalValueFinal: {
    fontSize: 18,
    fontWeight: '700',
  },
  modalStack: {
    flex: 1,
    backgroundColor: '#1C1C1E',
  },
  previousPageContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 25,
    paddingHorizontal: 12,
  },
  previousPage: {
    height: '100%',
    borderRadius: 12,
    opacity: 0.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  previousPageHeader: {
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previousPageNotch: {
    width: 40,
    height: 4,
    backgroundColor: '#8E8E93',
    borderRadius: 100,
  },
  customerContainer: {
    position: 'absolute',
    top: 55,
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 14,
  },
  closeChevron: {
    padding: 8,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  customerList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
  customerCard: {
    borderRadius: 10,
    marginBottom: 8,
    padding: 12,
  },
  customerCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  customerModalAvatar: {
    width: 36,
    height: 36,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalAvatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  customerModalDetails: {
    flex: 1,
  },
  customerModalName: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 2,
  },
  customerModalEmail: {
    fontSize: 14,
    marginBottom: 1,
  },
  customerModalCompany: {
    fontSize: 13,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
});