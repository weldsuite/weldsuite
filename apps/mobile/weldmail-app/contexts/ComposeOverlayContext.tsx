import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, BackHandler, View, Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import appApi from '@/services/app-api';
import ComposeScreen, { type ComposeCloseInfo, type ComposePrefill } from '@/app/compose';

type OpenComposeOptions = {
  /**
   * Invoked when the overlay closes. Receives draft info when the user backed
   * out with unsent content (mirrors the old `/compose` route's return params).
   * If omitted, a generic "Draft saved" toast is shown when a draft was kept.
   */
  onClose?: (info?: ComposeCloseInfo) => void;
};

interface ComposeOverlayContextValue {
  openCompose: (prefill?: ComposePrefill, options?: OpenComposeOptions) => void;
  closeCompose: (info?: ComposeCloseInfo) => void;
  isComposeOpen: boolean;
}

const ComposeOverlayContext = createContext<ComposeOverlayContextValue | undefined>(undefined);

export function ComposeOverlayProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [prefill, setPrefill] = useState<ComposePrefill>({});
  // Bumped on every open so ComposeScreen remounts with fresh internal state.
  const [instance, setInstance] = useState(0);
  const onCloseRef = useRef<OpenComposeOptions['onClose']>(undefined);

  const screenHeight = Dimensions.get('window').height;
  const anim = useRef(new Animated.Value(0)).current; // 0 = hidden (off-screen), 1 = shown

  const openCompose = useCallback((p?: ComposePrefill, options?: OpenComposeOptions) => {
    onCloseRef.current = options?.onClose;
    setPrefill(p ?? {});
    setInstance((n) => n + 1);
    setMounted(true);
    setOpen(true);
  }, []);

  const closeCompose = useCallback((info?: ComposeCloseInfo) => {
    // Dismiss the keyboard immediately so it animates out with the sheet.
    Keyboard.dismiss();
    setOpen(false);
    const cb = onCloseRef.current;
    onCloseRef.current = undefined;
    if (cb) {
      // The opener (e.g. the inbox) owns draft persistence + snackbar.
      cb(info);
    } else if (info?.draftSaved) {
      // Reply/forward openers don't supply a handler: persist in the
      // background and surface a toast, without blocking the close.
      if (info.draftAccountId) {
        appApi.mailDrafts.create({
          accountId: info.draftAccountId,
          to: info.draftTo ? info.draftTo.split(/[,;]\s*/).filter(Boolean) : undefined,
          cc: info.draftCc ? info.draftCc.split(/[,;]\s*/).filter(Boolean) : undefined,
          bcc: info.draftBcc ? info.draftBcc.split(/[,;]\s*/).filter(Boolean) : undefined,
          subject: info.draftSubject || undefined,
          body: info.draftBody || undefined,
        }).catch(() => {});
      }
      toast.success('Draft saved');
    }
  }, [toast]);

  // Slide the overlay in/out, then fully unmount once it has left the screen.
  // Appearing: the iOS sheet curve (gentle decelerate). Disappearing: a quicker
  // accelerate so it clears the screen crisply. Both directions drive the same
  // value, so the sheet slide, page recede and backdrop fade stay in lockstep.
  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? 480 : 200,
      easing: open
        ? Easing.bezier(0.32, 0.72, 0, 1) // iOS sheet present curve
        : Easing.bezier(0.4, 0, 0.85, 0.4), // accelerate out
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
  }, [open, anim]);

  // Android hardware back closes the overlay (matching modal behaviour).
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeCompose();
      return true;
    });
    return () => sub.remove();
  }, [open, closeCompose]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [screenHeight, 0],
  });
  const backdropOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.45],
  });

  // Where the compose sheet's top sits. A small band of the receded page shows
  // above it, which is what makes the inbox read as a layer underneath.
  const SHEET_TOP = insets.top + 14;

  // The page behind recedes into a clean, uniformly-inset rounded card on a
  // dark backdrop (mirrors the WeldAgent sheet in weldsuite-app): scale toward
  // the top, then push down past the notch so the page's own header isn't
  // cramped under the status bar. Bottom lifts up behind the sheet.
  const pageScale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.95],
  });
  const pageTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, insets.top],
  });

  return (
    <ComposeOverlayContext.Provider value={{ openCompose, closeCompose, isComposeOpen: open }}>
      {/* While open the screen top is the dark backdrop, so the phone status-bar
          icons (clock, wifi, battery) must flip to light. Reverts on close. */}
      {open && <StatusBar style="light" animated />}
      {/* Previous page — recedes into a clean card underneath the compose sheet */}
      <View style={[styles.pageRoot, { backgroundColor: mounted ? '#000' : colors.background }]}>
        <Animated.View
          style={[
            styles.page,
            {
              transformOrigin: 'top',
              transform: [{ translateY: pageTranslateY }, { scale: pageScale }],
              // borderRadius can't ride the native-driven anim, so toggle it statically.
              borderRadius: mounted ? 14 : 0,
            },
          ]}
        >
          {children}
        </Animated.View>
      </View>
      {mounted && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {/* Dim over the receded page so it sits back cleanly */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity }]}
          />
          {/* Compose sheet — slides up, overlapping the page below the gap */}
          <Animated.View
            style={[
              styles.sheet,
              {
                top: SHEET_TOP,
                backgroundColor: colors.background,
                transform: [{ translateY }],
              },
            ]}
          >
            <ComposeScreen
              key={instance}
              prefillOverride={prefill}
              onCloseOverride={closeCompose}
            />
          </Animated.View>
        </View>
      )}
    </ComposeOverlayContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Root turns dark while the sheet is open so the receded card sits on a dark
  // backdrop (iOS sheet depth); normal otherwise. Background set inline.
  pageRoot: {
    flex: 1,
  },
  page: {
    flex: 1,
    overflow: 'hidden',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
    // Subtle lift off the page behind it
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 16,
  },
});

export function useComposeOverlay(): ComposeOverlayContextValue {
  const ctx = useContext(ComposeOverlayContext);
  if (!ctx) {
    throw new Error('useComposeOverlay must be used within a ComposeOverlayProvider');
  }
  return ctx;
}
