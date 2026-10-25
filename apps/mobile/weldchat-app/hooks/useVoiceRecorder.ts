import { useCallback } from 'react';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';

export interface RecordingResult {
  uri: string;
  mimeType: string;
  name: string;
}

export function useVoiceRecorder() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 80);

  const startRecording = useCallback(async (): Promise<boolean> => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return false;

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();
      return true;
    } catch {
      return false;
    }
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) return null;

      // HIGH_QUALITY records AAC in an MPEG-4 container (.m4a) on both
      // platforms; labelling it 3GPP left browsers unable to play it.
      return { uri, mimeType: 'audio/mp4', name: `voice_${Date.now()}.m4a` };
    } catch {
      return null;
    }
  }, [recorder]);

  const cancelRecording = useCallback(async () => {
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      // best-effort
    }
  }, [recorder]);

  return {
    isRecording: recorderState.isRecording,
    durationMs: recorderState.durationMillis,
    meteringDb: recorderState.metering ?? -160,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
