/** Files and voice messages sent with a chat message, shared by every composer. */

import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';

import { appApi } from '@/services/app-api';

export interface ChatAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

/** React Native file descriptor produced by the document/image pickers. */
export type RNFile = { name: string; uri: string; mimeType: string };

/** Shorter recordings are dropped on send: almost always an accidental tap. */
export const MIN_VOICE_MESSAGE_MS = 1000;

/**
 * A picked file as a multipart part. The global `fetch` is Expo's (SDK 57),
 * which rejects React Native's `{ uri, type, name }` descriptor with
 * "Unsupported FormDataPart implementation"; it sends any part that has
 * `bytes()`, using its `name` and `type` as the part's filename and
 * Content-Type. The bytes come from expo-file-system so the picker's file name
 * survives (an `ExpoFile` alone would be named after its cache path).
 */
function multipartFilePart(file: RNFile) {
  const source = new ExpoFile(file.uri);
  return { name: file.name, type: file.mimeType, bytes: () => source.bytes() };
}

/**
 * Upload a picked RN file to app-api and map the response to a ChatAttachment.
 * The shared `upload` domain types its argument as a DOM `File`, so the part
 * is cast through `unknown`. Returns null on failure.
 */
export async function uploadChatAttachment(
  channelId: string,
  file: RNFile,
): Promise<ChatAttachment | null> {
  try {
    const part = multipartFilePart(file);
    const res = await appApi.chatMessages.upload(part as unknown as File, channelId);
    // The server returns `{ id, fileName, fileSize, mimeType, url, fileKey }`
    // (the upload service result); the shared response type omits `id`.
    return res.data as unknown as ChatAttachment;
  } catch (err) {
    console.error('[WeldChat] uploadChatAttachment failed:', err);
    return null;
  }
}

/** The composer's "+": photos from the library or any file. */
export function openAttachmentPicker(onPicked: (files: RNFile[]) => void): void {
  Alert.alert('Attach', undefined, [
    {
      text: 'Photo Library',
      onPress: async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          quality: 0.8,
        });
        if (!result.canceled && result.assets) {
          onPicked(
            result.assets.map((a) => ({
              name: a.fileName || `photo_${Date.now()}.jpg`,
              uri: a.uri,
              mimeType: a.mimeType || 'image/jpeg',
            })),
          );
        }
      },
    },
    {
      text: 'File',
      onPress: async () => {
        const result = await DocumentPicker.getDocumentAsync({ multiple: true });
        if (!result.canceled && result.assets) {
          onPicked(
            result.assets.map((a) => ({
              name: a.name,
              uri: a.uri,
              mimeType: a.mimeType || 'application/octet-stream',
            })),
          );
        }
      },
    },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
