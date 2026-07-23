import React, { createContext, useContext, useRef, useCallback, useState } from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, LayoutAnimation, Platform, UIManager } from 'react-native';

// Enable LayoutAnimation on Android (only needed for old architecture)
// In New Architecture this is a no-op, so we check for it to avoid warnings
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental &&
  !(global as any).__turboModuleProxy
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const smoothAnimation = {
  duration: 150,
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};

interface CollapsibleHeaderContextType {
  isCollapsed: boolean;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  resetHeader: () => void;
}

const CollapsibleHeaderContext = createContext<CollapsibleHeaderContextType | null>(null);

export function CollapsibleHeaderProvider({ children }: { children: React.ReactNode }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const lastScrollY = useRef(0);
  const isHidden = useRef(false);
  const debounceTimeout = useRef<NodeJS.Timeout | null>(null);
  const scrollAccumulator = useRef(0);

  const hideHeader = useCallback(() => {
    LayoutAnimation.configureNext(smoothAnimation);
    setIsCollapsed(true);
  }, []);

  const showHeader = useCallback(() => {
    LayoutAnimation.configureNext(smoothAnimation);
    setIsCollapsed(false);
  }, []);

  const resetHeader = useCallback(() => {
    if (isHidden.current) {
      LayoutAnimation.configureNext(smoothAnimation);
      setIsCollapsed(false);
      isHidden.current = false;
      scrollAccumulator.current = 0;
      lastScrollY.current = 0;
    }
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const currentScrollY = contentOffset.y;
    const diff = currentScrollY - lastScrollY.current;
    lastScrollY.current = currentScrollY;

    if (Math.abs(diff) < 1) return;
    if (debounceTimeout.current) return;

    // Near bottom - ignore to prevent bounce triggering header
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - currentScrollY;
    if (distanceFromBottom < 80) {
      scrollAccumulator.current = 0;
      return;
    }

    // Show header when at very top
    if (currentScrollY <= 5 && isHidden.current) {
      isHidden.current = false;
      showHeader();
      debounceTimeout.current = setTimeout(() => {
        debounceTimeout.current = null;
      }, 150);
      scrollAccumulator.current = 0;
      return;
    }

    if (currentScrollY < 60) {
      scrollAccumulator.current = 0;
      return;
    }

    if ((diff > 0 && scrollAccumulator.current >= 0) || (diff < 0 && scrollAccumulator.current <= 0)) {
      scrollAccumulator.current += diff;
    } else {
      scrollAccumulator.current = diff;
    }

    const threshold = 25;

    if (scrollAccumulator.current > threshold && !isHidden.current) {
      isHidden.current = true;
      scrollAccumulator.current = 0;
      hideHeader();
      debounceTimeout.current = setTimeout(() => {
        debounceTimeout.current = null;
      }, 150);
    }
    else if (scrollAccumulator.current < -threshold && isHidden.current) {
      isHidden.current = false;
      scrollAccumulator.current = 0;
      showHeader();
      debounceTimeout.current = setTimeout(() => {
        debounceTimeout.current = null;
      }, 150);
    }
  }, [hideHeader, showHeader]);

  return (
    <CollapsibleHeaderContext.Provider value={{ isCollapsed, onScroll, resetHeader }}>
      {children}
    </CollapsibleHeaderContext.Provider>
  );
}

export function useCollapsibleHeader() {
  const context = useContext(CollapsibleHeaderContext);
  if (!context) {
    return {
      isCollapsed: false,
      onScroll: () => {},
      resetHeader: () => {},
    };
  }
  return context;
}
