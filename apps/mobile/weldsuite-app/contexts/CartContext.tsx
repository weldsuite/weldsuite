import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import storage from '@/utils/storage';
import api from '@/services/api';

interface CartItem {
  id: string;
  productId: string;
  productName: string;
  price: number;
  quantity: number;
  imageUrl?: string;
  variantId?: string;
  variantName?: string;
}

interface CartContextType {
  items: CartItem[];
  totalItems: number;
  totalPrice: number;
  addToCart: (productId: string, quantity: number, variantId?: string) => Promise<void>;
  updateQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeFromCart: (itemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
  syncCart: () => Promise<void>;
  loading: boolean;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within CartProvider');
  }
  return context;
};

export const CartProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPrice, setTotalPrice] = useState(0);

  useEffect(() => {
    loadCart();
  }, []);

  useEffect(() => {
    calculateTotals();
    saveCart();
  }, [items]);

  const calculateTotals = () => {
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const price = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    setTotalItems(itemCount);
    setTotalPrice(price);
  };

  const loadCart = async () => {
    try {
      // Load from local storage first
      const savedCart = await storage.getItem('cart');
      if (savedCart) {
        setItems(JSON.parse(savedCart));
      }

      // Then sync with server (commented out for testing without backend)
      // await syncCart();
    } catch (error) {
      console.error('Error loading cart:', error);
    }
  };

  const saveCart = async () => {
    try {
      if (items.length > 0) {
        await storage.setItem('cart', JSON.stringify(items));
      } else {
        await storage.removeItem('cart');
      }
    } catch (error) {
      console.error('Error saving cart:', error);
    }
  };

  const syncCart = async () => {
    try {
      setLoading(true);
      const response = await api.getCart();
      if (response.data) {
        const cartItems: CartItem[] = response.data.items?.map((item: any) => ({
          id: item.id,
          productId: item.productId,
          productName: item.product?.title || 'Unknown Product',
          price: item.price || 0,
          quantity: item.quantity || 1,
          imageUrl: item.product?.featuredImageUrl,
          variantId: item.variantId,
          variantName: item.variant?.title,
        })) || [];
        setItems(cartItems);
      }
    } catch (error) {
      console.error('Error syncing cart:', error);
      // If sync fails, keep using local cart
    } finally {
      setLoading(false);
    }
  };

  const addToCart = async (productId: string, quantity: number, variantId?: string) => {
    try {
      setLoading(true);

      // Optimistic update
      const existingItemIndex = items.findIndex(
        item => item.productId === productId && item.variantId === variantId
      );

      if (existingItemIndex >= 0) {
        // Update quantity if item exists
        const updatedItems = [...items];
        updatedItems[existingItemIndex].quantity += quantity;
        setItems(updatedItems);
      } else {
        // Add new item (fetch product details for local display)
        const productResponse = await api.getProduct(productId);
        if (productResponse.data) {
          const product = productResponse.data;
          const newItem: CartItem = {
            id: Date.now().toString(), // Temporary ID
            productId,
            productName: product.title,
            price: product.price,
            quantity,
            imageUrl: product.featuredImageUrl,
            variantId,
            variantName: variantId ? product.variants?.find((v: any) => v.id === variantId)?.title : undefined,
          };
          setItems([...items, newItem]);
        }
      }

      // Sync with server
      await api.addToCart(productId, quantity, variantId);
      await syncCart();
    } catch (error) {
      console.error('Error adding to cart:', error);
      // Revert optimistic update
      await loadCart();
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const updateQuantity = async (itemId: string, quantity: number) => {
    try {
      setLoading(true);

      if (quantity <= 0) {
        await removeFromCart(itemId);
        return;
      }

      // Optimistic update
      const updatedItems = items.map(item =>
        item.id === itemId ? { ...item, quantity } : item
      );
      setItems(updatedItems);

      // Sync with server
      await api.updateCartItem(itemId, quantity);
      await syncCart();
    } catch (error) {
      console.error('Error updating quantity:', error);
      // Revert optimistic update
      await loadCart();
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const removeFromCart = async (itemId: string) => {
    try {
      setLoading(true);

      // Optimistic update
      setItems(items.filter(item => item.id !== itemId));

      // Sync with server
      await api.removeFromCart(itemId);
      await syncCart();
    } catch (error) {
      console.error('Error removing from cart:', error);
      // Revert optimistic update
      await loadCart();
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const clearCart = async () => {
    try {
      setLoading(true);

      // Optimistic update
      setItems([]);

      // Sync with server
      await api.clearCart();
      await syncCart();
    } catch (error) {
      console.error('Error clearing cart:', error);
      // Revert optimistic update
      await loadCart();
      throw error;
    } finally {
      setLoading(false);
    }
  };

  return (
    <CartContext.Provider
      value={{
        items,
        totalItems,
        totalPrice,
        addToCart,
        updateQuantity,
        removeFromCart,
        clearCart,
        syncCart,
        loading,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};