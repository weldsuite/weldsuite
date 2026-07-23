import { useState, useRef, useCallback, useEffect } from 'react';
import type RealtimeKitClient from '@cloudflare/realtimekit';

export type VirtualBackgroundType = 'none' | 'blur' | 'image';

export interface VirtualBackgroundPreference {
  type: VirtualBackgroundType;
  value: string | null; // blur intensity as string, or image URL
}

const STORAGE_KEY = 'weldmeet-virtual-bg';
const DEFAULT_BLUR_INTENSITY = 10;

// ── Preference persistence ────────────────────────────────────────────────

export function getStoredBackgroundPreference(): VirtualBackgroundPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { type: 'none', value: null };
}

function storeBackgroundPreference(pref: VirtualBackgroundPreference) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch { /* ignore */ }
}

// ── Hook for the settings page (no active meeting) ───────────────────────

export function useVirtualBackgroundPreference() {
  const [pref, setPref] = useState<VirtualBackgroundPreference>(getStoredBackgroundPreference);

  const setBlur = useCallback((intensity: number = DEFAULT_BLUR_INTENSITY) => {
    const next: VirtualBackgroundPreference = { type: 'blur', value: String(intensity) };
    setPref(next);
    storeBackgroundPreference(next);
  }, []);

  const setImage = useCallback((url: string) => {
    const next: VirtualBackgroundPreference = { type: 'image', value: url };
    setPref(next);
    storeBackgroundPreference(next);
  }, []);

  const clear = useCallback(() => {
    const next: VirtualBackgroundPreference = { type: 'none', value: null };
    setPref(next);
    storeBackgroundPreference(next);
  }, []);

  return {
    backgroundType: pref.type,
    backgroundValue: pref.value,
    setBlur,
    setImage,
    clear,
  };
}

// ── Hook for active calls (applies middleware to RealtimeKit) ─────────────

export function useVirtualBackground(meeting: RealtimeKitClient | null) {
  const [backgroundType, setBackgroundType] = useState<VirtualBackgroundType>('none');
  const [backgroundValue, setBackgroundValue] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const transformerRef = useRef<any>(null);
  const middlewareRef = useRef<any>(null);
  const initPromiseRef = useRef<Promise<any> | null>(null);
  const appliedRef = useRef(false);

  const getTransformer = useCallback(async () => {
    if (transformerRef.current) return transformerRef.current;
    if (!meeting) return null;
    if (initPromiseRef.current) return initPromiseRef.current;

    initPromiseRef.current = (async () => {
      const { default: RealtimeKitVideoBackgroundTransformer } = await import('@cloudflare/realtimekit-virtual-background');
      const transformer = await RealtimeKitVideoBackgroundTransformer.init({
        meeting,
        segmentationConfig: {
          pipeline: 'webgl2',
          model: 'mlkit',
          backend: 'wasmSimd',
          inputResolution: '256x256',
          targetFps: 30,
          deferInputResizing: false,
        },
        postProcessingConfig: {
          smoothSegmentationMask: true,
          jointBilateralFilter: { sigmaSpace: 10, sigmaColor: 0.1 },
          coverage: [0.5, 0.75],
          lightWrapping: 0.3,
          blendMode: 'screen',
        },
      });
      transformerRef.current = transformer;
      return transformer;
    })();

    return initPromiseRef.current;
  }, [meeting]);

  useEffect(() => {
    return () => {
      if (middlewareRef.current && meeting) {
        try { meeting.self.removeVideoMiddleware(middlewareRef.current); } catch { /* ignore */ }
      }
      transformerRef.current = null;
      initPromiseRef.current = null;
      middlewareRef.current = null;
      appliedRef.current = false;
    };
  }, [meeting]);

  const removeCurrentMiddleware = useCallback(() => {
    if (middlewareRef.current && meeting) {
      try { meeting.self.removeVideoMiddleware(middlewareRef.current); } catch { /* ignore */ }
      middlewareRef.current = null;
    }
  }, [meeting]);

  const applyBlur = useCallback(async (intensity: number = DEFAULT_BLUR_INTENSITY) => {
    if (!meeting) return;
    setIsLoading(true);
    try {
      const transformer = await getTransformer();
      if (!transformer) return;
      removeCurrentMiddleware();
      const middleware = await transformer.createBackgroundBlurVideoMiddleware(intensity);
      meeting.self.addVideoMiddleware(middleware);
      middlewareRef.current = middleware;
      setBackgroundType('blur');
      setBackgroundValue(String(intensity));
      storeBackgroundPreference({ type: 'blur', value: String(intensity) });
    } catch (e) {
      console.error('[VirtualBackground] Failed to apply blur:', e);
    } finally {
      setIsLoading(false);
    }
  }, [meeting, getTransformer, removeCurrentMiddleware]);

  const applyImage = useCallback(async (imageUrl: string) => {
    if (!meeting) return;
    setIsLoading(true);
    try {
      const transformer = await getTransformer();
      if (!transformer) return;
      removeCurrentMiddleware();
      const middleware = await transformer.createStaticBackgroundVideoMiddleware(imageUrl);
      meeting.self.addVideoMiddleware(middleware);
      middlewareRef.current = middleware;
      setBackgroundType('image');
      setBackgroundValue(imageUrl);
      storeBackgroundPreference({ type: 'image', value: imageUrl });
    } catch (e) {
      console.error('[VirtualBackground] Failed to apply image background:', e);
    } finally {
      setIsLoading(false);
    }
  }, [meeting, getTransformer, removeCurrentMiddleware]);

  const removeBackground = useCallback(() => {
    removeCurrentMiddleware();
    setBackgroundType('none');
    setBackgroundValue(null);
    storeBackgroundPreference({ type: 'none', value: null });
  }, [removeCurrentMiddleware]);

  // Auto-apply saved preference when meeting becomes available
  useEffect(() => {
    if (!meeting || appliedRef.current) return;
    appliedRef.current = true;

    const pref = getStoredBackgroundPreference();
    if (pref.type === 'blur' && pref.value) {
      applyBlur(Number(pref.value));
    } else if (pref.type === 'image' && pref.value) {
      applyImage(pref.value);
    }
  }, [meeting, applyBlur, applyImage]);

  return {
    backgroundType,
    backgroundValue,
    isLoading,
    applyBlur,
    applyImage,
    removeBackground,
  };
}
