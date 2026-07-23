import { useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { Audio } from 'expo-av';

export interface RecordingResult {
  uri: string;
  mimeType: string;
  name: string;
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [meteringDb, setMeteringDb] = useState(-160);
  const recordingRef = useRef<Audio.Recording | null>(null);

  const startRecording = useCallback(async (): Promise<boolean> => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') return false;

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true },
        (status) => {
          if (status.isRecording) {
            setDurationMs(status.durationMillis ?? 0);
            if (typeof status.metering === 'number') {
              setMeteringDb(status.metering);
            }
          }
        },
        80,
      );

      recordingRef.current = recording;
      setIsRecording(true);
      setDurationMs(0);
      setMeteringDb(-160);
      return true;
    } catch {
      return false;
    }
  }, []);

  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    const recording = recordingRef.current;
    if (!recording) return null;

    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recording.getURI();
      recordingRef.current = null;
      setIsRecording(false);
      setDurationMs(0);

      if (!uri) return null;

      const isIOS = Platform.OS === 'ios';
      const mimeType = isIOS ? 'audio/m4a' : 'audio/3gpp';
      const ext = isIOS ? 'm4a' : '3gp';
      return { uri, mimeType, name: `voice_${Date.now()}.${ext}` };
    } catch {
      recordingRef.current = null;
      setIsRecording(false);
      setDurationMs(0);
      return null;
    }
  }, []);

  const cancelRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {}
    recordingRef.current = null;
    setIsRecording(false);
    setDurationMs(0);
  }, []);

  return { isRecording, durationMs, meteringDb, startRecording, stopRecording, cancelRecording };
}
