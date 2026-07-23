import * as SecureStore from 'expo-secure-store';
import { TokenCache } from '@clerk/expo';

/**
 * Secure token cache for Clerk using expo-secure-store
 */
export const tokenCache: TokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      console.error('SecureStore getToken error:', error);
      return null;
    }
  },
  async saveToken(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (error) {
      console.error('SecureStore saveToken error:', error);
    }
  },
  async clearToken(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (error) {
      console.error('SecureStore clearToken error:', error);
    }
  },
};
