import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { ImageIcon, X } from 'lucide-react-native';

interface CoverImagePickerProps {
  coverImage?: string;
  onImageChange: (imageUrl: string | undefined) => void;
  onUpload: (imageUri: string) => Promise<string | undefined>;
  canWrite?: boolean;
}

export function CoverImagePicker({
  coverImage,
  onImageChange,
  onUpload,
  canWrite = true,
}: CoverImagePickerProps) {
  const [isUploading, setIsUploading] = useState(false);

  const handleSelectImage = async () => {
    try {
      // Request permission
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library to add a cover image.');
        return;
      }

      // Pick image
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.8,
      });

      if (result.canceled || !result.assets[0]) {
        return;
      }

      const asset = result.assets[0];

      // Check file size (5MB max)
      if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024) {
        Alert.alert('File Too Large', 'Please select an image smaller than 5MB.');
        return;
      }

      // Upload image
      setIsUploading(true);
      try {
        const uploadedUrl = await onUpload(asset.uri);
        if (uploadedUrl) {
          onImageChange(uploadedUrl);
        }
      } catch (error) {
        console.error('Upload error:', error);
        Alert.alert('Upload Failed', 'Failed to upload the cover image. Please try again.');
      } finally {
        setIsUploading(false);
      }
    } catch (error) {
      console.error('Image picker error:', error);
      Alert.alert('Error', 'An error occurred while selecting the image.');
    }
  };

  const handleRemoveImage = () => {
    Alert.alert(
      'Remove Cover Image',
      'Are you sure you want to remove the cover image?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => onImageChange(undefined),
        },
      ]
    );
  };

  // Show cover image
  if (coverImage) {
    return (
      <View style={styles.coverContainer}>
        <Image
          source={{ uri: coverImage }}
          style={styles.coverImage}
          contentFit="cover"
        />
        {canWrite && (
          <View style={styles.coverActions}>
            <TouchableOpacity
              style={styles.coverActionButton}
              onPress={handleSelectImage}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color="#374151" />
              ) : (
                <>
                  <ImageIcon size={16} color="#374151" strokeWidth={2} />
                  <Text style={styles.coverActionText}>Change</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.coverActionButton}
              onPress={handleRemoveImage}
              disabled={isUploading}
            >
              <X size={16} color="#374151" strokeWidth={2} />
              <Text style={styles.coverActionText}>Remove</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // Show add cover button
  if (!canWrite) {
    return null;
  }

  return (
    <TouchableOpacity
      style={styles.addCoverButton}
      onPress={handleSelectImage}
      disabled={isUploading}
    >
      {isUploading ? (
        <ActivityIndicator size="small" color="#6B7280" />
      ) : (
        <>
          <ImageIcon size={16} color="#6B7280" strokeWidth={2} />
          <Text style={styles.addCoverText}>Add cover image</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  coverContainer: {
    position: 'relative',
    width: '100%',
    height: 200,
    marginBottom: 16,
  },
  coverImage: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  coverActions: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    gap: 8,
  },
  coverActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
  },
  coverActionText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
  },
  addCoverButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    gap: 8,
  },
  addCoverText: {
    fontSize: 14,
    color: '#6B7280',
  },
});
