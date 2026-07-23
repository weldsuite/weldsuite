// Persistent storage utility using AsyncStorage
// Settings and preferences persist across app restarts

import AsyncStorage from '@react-native-async-storage/async-storage';

// Storage keys prefix to avoid conflicts
const STORAGE_PREFIX = '@weldsuite:';

class PersistentStorage {
  private getFullKey(key: string): string {
    return `${STORAGE_PREFIX}${key}`;
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(this.getFullKey(key));
    } catch (error) {
      console.error(`Error getting item ${key}:`, error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(this.getFullKey(key), value);
    } catch (error) {
      console.error(`Error setting item ${key}:`, error);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(this.getFullKey(key));
    } catch (error) {
      console.error(`Error removing item ${key}:`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      // Only clear keys with our prefix
      const allKeys = await AsyncStorage.getAllKeys();
      const ourKeys = allKeys.filter(key => key.startsWith(STORAGE_PREFIX));
      if (ourKeys.length > 0) {
        await AsyncStorage.multiRemove(ourKeys);
      }
    } catch (error) {
      console.error('Error clearing storage:', error);
    }
  }

  async getAllKeys(): Promise<string[]> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      return allKeys
        .filter(key => key.startsWith(STORAGE_PREFIX))
        .map(key => key.replace(STORAGE_PREFIX, ''));
    } catch (error) {
      console.error('Error getting all keys:', error);
      return [];
    }
  }

  async getMultiple(keys: string[]): Promise<Record<string, string | null>> {
    try {
      const fullKeys = keys.map(key => this.getFullKey(key));
      const pairs = await AsyncStorage.multiGet(fullKeys);
      const result: Record<string, string | null> = {};
      pairs.forEach(([fullKey, value]) => {
        const key = fullKey.replace(STORAGE_PREFIX, '');
        result[key] = value;
      });
      return result;
    } catch (error) {
      console.error('Error getting multiple items:', error);
      return {};
    }
  }

  async setMultiple(items: Record<string, string>): Promise<void> {
    try {
      const pairs: [string, string][] = Object.entries(items).map(
        ([key, value]) => [this.getFullKey(key), value]
      );
      await AsyncStorage.multiSet(pairs);
    } catch (error) {
      console.error('Error setting multiple items:', error);
    }
  }
}

// Create singleton instance
const storage = new PersistentStorage();

export default storage;
