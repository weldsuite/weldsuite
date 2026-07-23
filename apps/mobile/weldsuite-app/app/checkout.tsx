import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCart } from '@/contexts/CartContext';
import { useToast } from '@/contexts/ToastContext';
import { track } from '@/lib/analytics';
import api, { Address } from '@/services/api';

interface CheckoutFormData {
  shippingAddress: Address;
  paymentMethod: 'credit_card' | 'paypal' | 'apple_pay' | 'google_pay';
}

const PAYMENT_METHODS = [
  {
    id: 'credit_card' as const,
    name: 'Credit Card',
    icon: 'card-outline' as const,
    description: 'Visa, Mastercard, American Express',
  },
  {
    id: 'paypal' as const,
    name: 'PayPal',
    icon: 'logo-paypal' as const,
    description: 'Pay with your PayPal account',
  },
  {
    id: 'apple_pay' as const,
    name: 'Apple Pay',
    icon: 'logo-apple' as const,
    description: 'Touch ID or Face ID',
  },
  {
    id: 'google_pay' as const,
    name: 'Google Pay',
    icon: 'logo-google' as const,
    description: 'Pay with Google',
  },
];

export default function CheckoutScreen() {
  const { items, totalPrice, clearCart, loading: cartLoading } = useCart();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<Address[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [formData, setFormData] = useState<CheckoutFormData>({
    shippingAddress: {
      firstName: '',
      lastName: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      postalCode: '',
      country: 'US',
    },
    paymentMethod: 'credit_card',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    track('Checkout Started');
    loadSavedAddresses();
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      router.replace('/(tabs)/cart');
    }
  }, [items]);

  const loadSavedAddresses = async () => {
    try {
      const response = await api.getAddresses();
      if (response.success && response.data) {
        setSavedAddresses(response.data);
        const defaultAddress = response.data.find(addr => addr.isDefault);
        if (defaultAddress) {
          setSelectedAddressId(defaultAddress.id!);
          setFormData(prev => ({ ...prev, shippingAddress: defaultAddress }));
        } else if (response.data.length > 0) {
          setSelectedAddressId(response.data[0].id!);
          setFormData(prev => ({ ...prev, shippingAddress: response.data[0] }));
        } else {
          setShowAddressForm(true);
        }
      }
    } catch (error) {
      console.error('Error loading addresses:', error);
    }
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Validate shipping address
    if (!formData.shippingAddress.firstName.trim()) {
      newErrors.firstName = 'First name is required';
    }
    if (!formData.shippingAddress.lastName.trim()) {
      newErrors.lastName = 'Last name is required';
    }
    if (!formData.shippingAddress.addressLine1.trim()) {
      newErrors.addressLine1 = 'Address is required';
    }
    if (!formData.shippingAddress.city.trim()) {
      newErrors.city = 'City is required';
    }
    if (!formData.shippingAddress.state.trim()) {
      newErrors.state = 'State is required';
    }
    if (!formData.shippingAddress.postalCode.trim()) {
      newErrors.postalCode = 'Postal code is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handlePlaceOrder = async () => {
    if (!validateForm()) {
      toast.error('Please fill in all required fields');
      return;
    }

    try {
      setLoading(true);

      const orderResponse = await api.createOrder({
        shippingAddress: formData.shippingAddress,
        paymentMethod: formData.paymentMethod,
      });

      if (orderResponse.success && orderResponse.data) {
        track('Checkout Completed');
        await clearCart();
        toast.success(`Your order #${orderResponse.data.orderNumber} has been placed successfully.`);
        router.replace(`/order/${orderResponse.data.id}` as any);
      } else {
        throw new Error(orderResponse.error || 'Failed to place order');
      }
    } catch (error) {
      console.error('Error placing order:', error);
      toast.error('Failed to place order. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddressSelect = (address: Address) => {
    setSelectedAddressId(address.id!);
    setFormData(prev => ({ ...prev, shippingAddress: address }));
    setShowAddressForm(false);
  };

  const updateShippingAddress = (field: keyof Address, value: string) => {
    setFormData(prev => ({
      ...prev,
      shippingAddress: { ...prev.shippingAddress, [field]: value },
    }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const renderOrderSummary = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Order Summary</Text>
      <View style={styles.summaryContainer}>
        {items.map((item) => (
          <View key={item.id} style={styles.summaryItem}>
            <Text style={styles.summaryItemName} numberOfLines={2}>
              {item.productName}
              {item.variantName && ` - ${item.variantName}`}
            </Text>
            <Text style={styles.summaryItemDetails}>
              ${item.price.toFixed(2)} × {item.quantity}
            </Text>
            <Text style={styles.summaryItemTotal}>
              ${(item.price * item.quantity).toFixed(2)}
            </Text>
          </View>
        ))}

        <View style={styles.summaryDivider} />

        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Subtotal</Text>
          <Text style={styles.summaryValue}>${totalPrice.toFixed(2)}</Text>
        </View>

        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Shipping</Text>
          <Text style={styles.summaryValue}>Free</Text>
        </View>

        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Tax</Text>
          <Text style={styles.summaryValue}>$0.00</Text>
        </View>

        <View style={styles.summaryDivider} />

        <View style={styles.summaryRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>${totalPrice.toFixed(2)}</Text>
        </View>
      </View>
    </View>
  );

  const renderShippingAddress = () => (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Shipping Address</Text>
        {savedAddresses.length > 0 && !showAddressForm && (
          <TouchableOpacity onPress={() => setShowAddressForm(true)}>
            <Text style={styles.changeButton}>Change</Text>
          </TouchableOpacity>
        )}
      </View>

      {!showAddressForm && selectedAddressId ? (
        <View style={styles.selectedAddress}>
          <Text style={styles.addressName}>
            {formData.shippingAddress.firstName} {formData.shippingAddress.lastName}
          </Text>
          <Text style={styles.addressText}>{formData.shippingAddress.addressLine1}</Text>
          {formData.shippingAddress.addressLine2 && (
            <Text style={styles.addressText}>{formData.shippingAddress.addressLine2}</Text>
          )}
          <Text style={styles.addressText}>
            {formData.shippingAddress.city}, {formData.shippingAddress.state} {formData.shippingAddress.postalCode}
          </Text>
        </View>
      ) : (
        <View style={styles.addressForm}>
          {savedAddresses.length > 0 && (
            <View style={styles.savedAddresses}>
              <Text style={styles.savedAddressesTitle}>Saved Addresses</Text>
              {savedAddresses.map((address) => (
                <TouchableOpacity
                  key={address.id}
                  style={styles.savedAddressItem}
                  onPress={() => handleAddressSelect(address)}
                >
                  <Text style={styles.savedAddressName}>
                    {address.firstName} {address.lastName}
                  </Text>
                  <Text style={styles.savedAddressText}>
                    {address.addressLine1}, {address.city}, {address.state}
                  </Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.orText}>Or enter a new address:</Text>
            </View>
          )}

          <View style={styles.inputRow}>
            <View style={[styles.inputContainer, { flex: 1, marginRight: 8 }]}>
              <Text style={styles.inputLabel}>First Name *</Text>
              <TextInput
                style={[styles.input, errors.firstName && styles.inputError]}
                value={formData.shippingAddress.firstName}
                onChangeText={(value) => updateShippingAddress('firstName', value)}
                placeholder="First name"
              />
              {errors.firstName && <Text style={styles.errorText}>{errors.firstName}</Text>}
            </View>
            <View style={[styles.inputContainer, { flex: 1, marginLeft: 8 }]}>
              <Text style={styles.inputLabel}>Last Name *</Text>
              <TextInput
                style={[styles.input, errors.lastName && styles.inputError]}
                value={formData.shippingAddress.lastName}
                onChangeText={(value) => updateShippingAddress('lastName', value)}
                placeholder="Last name"
              />
              {errors.lastName && <Text style={styles.errorText}>{errors.lastName}</Text>}
            </View>
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>Address Line 1 *</Text>
            <TextInput
              style={[styles.input, errors.addressLine1 && styles.inputError]}
              value={formData.shippingAddress.addressLine1}
              onChangeText={(value) => updateShippingAddress('addressLine1', value)}
              placeholder="Street address"
            />
            {errors.addressLine1 && <Text style={styles.errorText}>{errors.addressLine1}</Text>}
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>Address Line 2</Text>
            <TextInput
              style={styles.input}
              value={formData.shippingAddress.addressLine2}
              onChangeText={(value) => updateShippingAddress('addressLine2', value)}
              placeholder="Apartment, suite, etc. (optional)"
            />
          </View>

          <View style={styles.inputRow}>
            <View style={[styles.inputContainer, { flex: 2, marginRight: 8 }]}>
              <Text style={styles.inputLabel}>City *</Text>
              <TextInput
                style={[styles.input, errors.city && styles.inputError]}
                value={formData.shippingAddress.city}
                onChangeText={(value) => updateShippingAddress('city', value)}
                placeholder="City"
              />
              {errors.city && <Text style={styles.errorText}>{errors.city}</Text>}
            </View>
            <View style={[styles.inputContainer, { flex: 1, marginHorizontal: 4 }]}>
              <Text style={styles.inputLabel}>State *</Text>
              <TextInput
                style={[styles.input, errors.state && styles.inputError]}
                value={formData.shippingAddress.state}
                onChangeText={(value) => updateShippingAddress('state', value)}
                placeholder="State"
              />
              {errors.state && <Text style={styles.errorText}>{errors.state}</Text>}
            </View>
            <View style={[styles.inputContainer, { flex: 1, marginLeft: 8 }]}>
              <Text style={styles.inputLabel}>ZIP *</Text>
              <TextInput
                style={[styles.input, errors.postalCode && styles.inputError]}
                value={formData.shippingAddress.postalCode}
                onChangeText={(value) => updateShippingAddress('postalCode', value)}
                placeholder="ZIP"
                keyboardType="numeric"
              />
              {errors.postalCode && <Text style={styles.errorText}>{errors.postalCode}</Text>}
            </View>
          </View>
        </View>
      )}
    </View>
  );

  const renderPaymentMethod = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Payment Method</Text>
      <View style={styles.paymentMethods}>
        {PAYMENT_METHODS.map((method) => (
          <TouchableOpacity
            key={method.id}
            style={[
              styles.paymentMethod,
              formData.paymentMethod === method.id && styles.paymentMethodSelected,
            ]}
            onPress={() => setFormData(prev => ({ ...prev, paymentMethod: method.id }))}
          >
            <View style={styles.paymentMethodIcon}>
              <Ionicons name={method.icon} size={24} color="#007AFF" />
            </View>
            <View style={styles.paymentMethodInfo}>
              <Text style={styles.paymentMethodName}>{method.name}</Text>
              <Text style={styles.paymentMethodDescription}>{method.description}</Text>
            </View>
            <View style={styles.paymentMethodRadio}>
              <View
                style={[
                  styles.radioCircle,
                  formData.paymentMethod === method.id && styles.radioCircleSelected,
                ]}
              >
                {formData.paymentMethod === method.id && (
                  <View style={styles.radioInner} />
                )}
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  if (items.length === 0) {
    return null; // Will redirect in useEffect
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={24} color="#333" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Checkout</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {renderOrderSummary()}
          {renderShippingAddress()}
          {renderPaymentMethod()}

          <TouchableOpacity
            style={[styles.placeOrderButton, (loading || cartLoading) && styles.placeOrderButtonDisabled]}
            onPress={handlePlaceOrder}
            disabled={loading || cartLoading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                <Text style={styles.placeOrderButtonText}>
                  Place Order - ${totalPrice.toFixed(2)}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  keyboardAvoid: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
  },
  section: {
    backgroundColor: '#fff',
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  changeButton: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
  },
  summaryContainer: {
    marginTop: 16,
  },
  summaryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  summaryItemName: {
    flex: 2,
    fontSize: 14,
    marginRight: 8,
  },
  summaryItemDetails: {
    flex: 1,
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  summaryItemTotal: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
  summaryDivider: {
    height: 1,
    backgroundColor: '#e0e0e0',
    marginVertical: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  summaryLabel: {
    fontSize: 16,
    color: '#666',
  },
  summaryValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  totalLabel: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  selectedAddress: {
    padding: 16,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  addressName: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  addressText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 2,
  },
  addressForm: {
    marginTop: 16,
  },
  savedAddresses: {
    marginBottom: 20,
  },
  savedAddressesTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  savedAddressItem: {
    padding: 12,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  savedAddressName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  savedAddressText: {
    fontSize: 13,
    color: '#666',
  },
  orText: {
    fontSize: 14,
    color: '#666',
    marginTop: 12,
    marginBottom: 16,
    textAlign: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  inputContainer: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
    color: '#333',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  inputError: {
    borderColor: '#dc3545',
  },
  errorText: {
    fontSize: 12,
    color: '#dc3545',
    marginTop: 4,
  },
  paymentMethods: {
    marginTop: 16,
  },
  paymentMethod: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    marginBottom: 12,
  },
  paymentMethodSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#f8f9fa',
  },
  paymentMethodIcon: {
    width: 40,
    alignItems: 'center',
    marginRight: 12,
  },
  paymentMethodInfo: {
    flex: 1,
  },
  paymentMethodName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  paymentMethodDescription: {
    fontSize: 14,
    color: '#666',
  },
  paymentMethodRadio: {
    marginLeft: 12,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#e0e0e0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCircleSelected: {
    borderColor: '#007AFF',
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#007AFF',
  },
  placeOrderButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    margin: 16,
  },
  placeOrderButtonDisabled: {
    opacity: 0.5,
  },
  placeOrderButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 8,
  },
});