import { Tabs } from "expo-router";
import React, { useState, useEffect, useRef } from "react";
import { Calculator, FileText, TrendingUp, ChevronLeft, BarChart, Inbox, Menu, Home, CreditCard, Settings, HelpCircle, X } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, Modal, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, Easing, Keyboard, LayoutAnimation, UIManager, ActivityIndicator, Switch, Dimensions } from 'react-native';
import { router } from 'expo-router';
import WeldAgentLogo from '@/components/WeldAgentLogo';
import { Camera, CameraView } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import Svg, { Line, Circle, Polygon } from 'react-native-svg';
// import DocumentScanner from 'react-native-document-scanner-plugin';

// Enable LayoutAnimation on Android (only needed for old architecture)
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental &&
  !(global as any).__turboModuleProxy
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function AccountingTabsLayout() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  const [scanModalVisible, setScanModalVisible] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [flashMode, setFlashMode] = useState<'off' | 'on'>('off');
  const [processing, setProcessing] = useState(false);
  const [autoCapture, setAutoCapture] = useState(true);
  const [documentDetected, setDocumentDetected] = useState(false);
  const [detectionQuality, setDetectionQuality] = useState<'good' | 'poor' | 'none'>('none');
  const [receiptBoundaries, setReceiptBoundaries] = useState<Array<{ x: number; y: number }> | null>(null);
  const [message, setMessage] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const cameraRef = useRef<any>(null);
  const detectionTimerRef = useRef<any>(null);
  const slideAnim = useRef(new Animated.Value(1000)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const keyboardHeight = useRef(new Animated.Value(0)).current;
  const menuSlideAnim = useRef(new Animated.Value(-320)).current;
  const backdropOpacityAnim = useRef(new Animated.Value(0)).current;
  const scanSlideAnim = useRef(new Animated.Value(1000)).current;

  // Keyboard animation listeners for WhatsApp-like smooth transitions
  useEffect(() => {
    const showListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardWillShow',
      (e) => {
        setIsKeyboardVisible(true);
        // Use spring animation for natural movement like WhatsApp
        LayoutAnimation.configureNext(
          LayoutAnimation.create(
            e.duration || 250,
            LayoutAnimation.Types.keyboard,
            LayoutAnimation.Properties.opacity
          )
        );
      }
    );

    const hideListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardWillHide',
      (e) => {
        setIsKeyboardVisible(false);
        // Use spring animation for natural movement
        LayoutAnimation.configureNext(
          LayoutAnimation.create(
            e.duration || 250,
            LayoutAnimation.Types.keyboard,
            LayoutAnimation.Properties.opacity
          )
        );
      }
    );

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  useEffect(() => {
    if (agentModalVisible) {
      // Start animations immediately without resetting
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(scaleAnim, {
          toValue: 0.95,
          duration: 250,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 1000,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
          easing: Easing.bezier(0.4, 0.0, 0.2, 1),
        }),
      ]).start(() => {
        // Reset values after close animation completes
        slideAnim.setValue(1000);
        fadeAnim.setValue(0);
        scaleAnim.setValue(1);
      });
    }
  }, [agentModalVisible]);

  useEffect(() => {
    if (menuModalVisible) {
      backdropOpacityAnim.setValue(1);
      menuSlideAnim.setValue(-320);

      requestAnimationFrame(() => {
        Animated.spring(menuSlideAnim, {
          toValue: 0,
          useNativeDriver: true,
          friction: 9,
          tension: 50,
        }).start();
      });
    }
  }, [menuModalVisible]);

  const closeMenu = () => {
    Animated.timing(menuSlideAnim, {
      toValue: -320,
      duration: 250,
      useNativeDriver: true,
      easing: Easing.out(Easing.ease),
    }).start(() => {
      setMenuModalVisible(false);
      backdropOpacityAnim.setValue(0);
    });
  };

  // Scan modal animation
  useEffect(() => {
    if (scanModalVisible) {
      Animated.spring(scanSlideAnim, {
        toValue: 0,
        useNativeDriver: true,
        friction: 9,
        tension: 50,
      }).start();
    } else {
      Animated.timing(scanSlideAnim, {
        toValue: 1000,
        duration: 250,
        useNativeDriver: true,
        easing: Easing.out(Easing.ease),
      }).start();
    }
  }, [scanModalVisible]);

  // Request camera permissions
  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  // Improved document detection simulation
  useEffect(() => {
    if (showCamera) {
      let targetBoundaries: any = null;
      let currentBoundaries: any = null;
      let detectionStability = 0; // Tracks how long document has been stable

      const simulateDetection = () => {
        const random = Math.random();

        // 75% chance of detecting something
        if (random > 0.25) {
          setDocumentDetected(true);

          // Generate or update target boundaries
          if (!targetBoundaries || random < 0.05) { // Only change target rarely
            const centerX = 40 + Math.random() * 20; // Center X between 40-60%
            const centerY = 40 + Math.random() * 20; // Center Y between 40-60%
            const width = 35 + Math.random() * 10; // Width 35-45%
            const height = 45 + Math.random() * 10; // Height 45-55%

            // Create 4-corner boundary (receipt shape)
            targetBoundaries = [
              { x: centerX - width / 2, y: centerY - height / 2 }, // Top-left
              { x: centerX + width / 2, y: centerY - height / 2 }, // Top-right
              { x: centerX + width / 2, y: centerY + height / 2 }, // Bottom-right
              { x: centerX - width / 2, y: centerY + height / 2 }, // Bottom-left
            ];

            // Evaluate quality
            const isWellCentered = centerX > 45 && centerX < 55 && centerY > 45 && centerY < 55;
            const isWellSized = width > 38 && width < 42 && height > 48 && height < 52;

            if (isWellCentered && isWellSized) {
              detectionStability++;
              if (detectionStability > 3) {
                setDetectionQuality('good');
              } else {
                setDetectionQuality('poor');
              }
            } else {
              detectionStability = 0;
              setDetectionQuality('poor');
            }
          } else {
            // Keep incrementing stability if document stays in good position
            if (detectionQuality === 'poor') {
              detectionStability++;
              if (detectionStability > 3) {
                setDetectionQuality('good');
              }
            }
          }

          // Smooth interpolation
          if (!currentBoundaries) {
            currentBoundaries = targetBoundaries;
          } else {
            const lerp = 0.15; // Slower, smoother movement
            currentBoundaries = currentBoundaries.map((point: any, i: number) => ({
              x: point.x + (targetBoundaries[i].x - point.x) * lerp,
              y: point.y + (targetBoundaries[i].y - point.y) * lerp,
            }));
          }

          setReceiptBoundaries(currentBoundaries);
        } else {
          // No receipt detected
          setDocumentDetected(false);
          setDetectionQuality('none');
          setReceiptBoundaries(null);
          currentBoundaries = null;
          targetBoundaries = null;
          detectionStability = 0;
        }
      };

      detectionTimerRef.current = setInterval(simulateDetection, 200); // Slower updates

      return () => {
        if (detectionTimerRef.current) {
          clearInterval(detectionTimerRef.current);
        }
      };
    } else {
      setDocumentDetected(false);
      setDetectionQuality('none');
      setReceiptBoundaries(null);
    }
  }, [showCamera, detectionQuality]);

  // Auto-capture when document is detected with good quality
  useEffect(() => {
    if (autoCapture && documentDetected && detectionQuality === 'good' && showCamera) {
      const timeout = setTimeout(() => {
        handleCapture();
      }, 1000);

      return () => clearTimeout(timeout);
    }
  }, [autoCapture, documentDetected, detectionQuality, showCamera]);

  // Scan handlers
  const handleScanWithCamera = async () => {
    setScanModalVisible(false);
    // Open the camera view instead of using native scanner
    setShowCamera(true);
  };

  const handleCapture = async () => {
    if (cameraRef.current) {
      try {
        setProcessing(true);
        const photo = await cameraRef.current.takePictureAsync({
          quality: 1,
          base64: false,
        });

        setShowCamera(false);

        // AI-powered OCR extraction has been removed along with the AI
        // backend — the photo is captured, but no data is auto-extracted.
        setProcessing(false);
        toast.info('AI is currently unavailable. Photo captured — please enter details manually.');
      } catch (error) {
        console.error('Error taking picture:', error);
        setProcessing(false);
        setShowCamera(false);
        toast.error('Failed to capture photo');
      }
    }
  };

  const handleGalleryPick = async () => {
    setScanModalVisible(false);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });

    if (!result.canceled) {
      // Process the image - you can add your processing logic here
      toast.success('Image selected successfully');
    }
  };

  const handleDocumentPick = async () => {
    setScanModalVisible(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        // Process the document - you can add your processing logic here
        toast.success('Document selected successfully');
      }
    } catch (err) {
      console.error('Document picker error:', err);
      toast.error('Failed to pick document');
    }
  };

  const HeaderLeft = () => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TouchableOpacity
        onPress={() => router.replace('/(tabs)')}
        style={styles.homeButton}
      >
        <Home size={18} color="#374151" strokeWidth={2} />
        <Text style={styles.homeButtonText}>Home</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => setMenuModalVisible(true)}
        style={styles.menuButton}
      >
        <Menu size={20} color="#374151" strokeWidth={2} />
      </TouchableOpacity>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>Accounting</Text>
    </View>
  );

  // AI (WeldAgent) has been removed along with the AI backend — the button
  // now surfaces an unavailable notice instead of opening the agent overlay.
  const HeaderRight = () => (
    <TouchableOpacity
      style={{ marginRight: 16 }}
      onPress={() => toast.info('AI is currently unavailable')}
    >
      <WeldAgentLogo size={20} color="#000000" />
    </TouchableOpacity>
  );

  return (
    <>
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        headerShown: true,
        headerStyle: {
          backgroundColor: colors.background,
          borderBottomWidth: 0.5,
          borderBottomColor: '#E5E7EB',
          height: 100,
        },
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerLeft: HeaderLeft,
        headerRight: HeaderRight,
        headerTitle: '',
        headerLeftContainerStyle: {
          paddingLeft: 16,
        },
        tabBarStyle: {
          backgroundColor: colors.cardBackground,
          height: 50 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          marginTop: 2,
        },
        tabBarIconStyle: {
          marginBottom: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => (
            <Calculator size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="inbox"
        options={{
          title: "My Inbox",
          tabBarIcon: ({ color, size }) => (
            <Inbox size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="scan" size={20} color={color} />
          ),
        }}
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            setScanModalVisible(true);
          },
        }}
      />

      <Tabs.Screen
        name="invoices"
        options={{
          title: "Invoices",
          tabBarIcon: ({ color, size }) => (
            <FileText size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="banks"
        options={{
          title: "Banks",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="card" size={20} color={color} />
          ),
        }}
      />

      {/* Hide ledger tab */}
      <Tabs.Screen
        name="ledger"
        options={{
          href: null,
        }}
      />

      {/* Hide analytics tab */}
      <Tabs.Screen
        name="analytics"
        options={{
          href: null,
        }}
      />
    </Tabs>

    {/* WeldAgent Overlay */}
    <Modal
      animationType="none"
      transparent={true}
      visible={agentModalVisible}
      onRequestClose={() => setAgentModalVisible(false)}
      presentationStyle="overFullScreen"
      statusBarTranslucent={true}
    >
      <View style={{ flex: 1, backgroundColor: '#1C1C1E' }}>
        <Animated.View style={[{ flex: 1, opacity: fadeAnim }]}>
          {/* Previous page scaled and pushed back */}
          <View style={styles.previousPageContainer}>
            <Animated.View style={[
              styles.previousPage, 
              { 
                backgroundColor: colors.background,
                transform: [{ scale: scaleAnim }],
              }
            ]}>
              <View style={styles.previousPageHeader}>
                <View style={styles.previousPageNotch} />
              </View>
            </Animated.View>
          </View>
          
          {/* Agent Container with KeyboardAvoidingView */}
          <KeyboardAvoidingView 
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ 
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
            keyboardVerticalOffset={0}
          >
            <Animated.View 
              style={[
                styles.agentContainer, 
                { 
                  backgroundColor: colors.background,
                  transform: [{ translateY: slideAnim }],
                  flex: 1,
                  marginTop: 55,
                }
              ]}
            >
              {/* Agent Header */}
              <View style={[styles.agentHeader, { backgroundColor: colors.background }]}>
                <TouchableOpacity 
                  onPress={() => setAgentModalVisible(false)}
                  style={styles.closeChevron}
                >
                  <ChevronLeft size={24} color={colors.muted} strokeWidth={2} />
                </TouchableOpacity>
                <Text style={[styles.conversationTitle, { color: colors.text }]}>New conversation</Text>
                <TouchableOpacity style={styles.editButton}>
                  <Ionicons name="create-outline" size={22} color={colors.text} />
                </TouchableOpacity>
              </View>

              {/* Scrollable Content */}
              <ScrollView 
                style={{ flex: 1, backgroundColor: colors.background }} 
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                  padding: 24,
                  paddingBottom: 20,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                {/* Welcome Section */}
                <View style={styles.welcomeSection}>
                  <View style={[styles.agentAvatar, { backgroundColor: '#7C3AED' }]}>
                    <WeldAgentLogo size={36} color="#7C3AED" />
                  </View>
                  <Text style={[styles.heyThere, { color: colors.text }]}>Hey there</Text>
                  <Text style={[styles.howCanIHelp, { color: '#7C3AED' }]}>How can I help?</Text>
                  
                  {/* What's new button */}
                  <TouchableOpacity style={styles.whatsNewButton}>
                    <View style={styles.bulletPoint} />
                    <Text style={[styles.whatsNewText, { color: colors.muted }]}>What's new?</Text>
                  </TouchableOpacity>
                </View>

                {/* Suggestion Pills */}
                <View style={styles.suggestionPills}>
                  <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                    <Text style={[styles.suggestionPillText, { color: colors.text }]}>Show financial summary</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                    <Text style={[styles.suggestionPillText, { color: colors.text }]}>Generate monthly report</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>

              {/* Input Bar */}
              <View style={[styles.inputBarFixed, { 
                backgroundColor: colors.background,
                position: 'relative',
              }]}>
                <View style={styles.inputContainer}>
                  {/* Input Field */}
                  <View style={styles.inputFieldWrapper}>
                    <TextInput
                      style={[styles.agentInput, { color: colors.text }]}
                      placeholder="Type a message..."
                      placeholderTextColor={colors.muted}
                      value={message}
                      onChangeText={setMessage}
                      multiline
                      numberOfLines={1}
                      maxLength={500}
                      textAlignVertical="top"
                      returnKeyType="send"
                      blurOnSubmit={false}
                      enablesReturnKeyAutomatically={true}
                    />
                  </View>
                  
                  {/* Controls row */}
                  <View style={styles.controlsRow}>
                    <TouchableOpacity style={styles.plusButton}>
                      <Ionicons name="add" size={20} color={colors.muted} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.sourcesButton}>
                      <Ionicons name="grid-outline" size={16} color={colors.muted} />
                      <Text style={[styles.sourcesText, { color: colors.muted }]}>Sources</Text>
                      <Ionicons name="chevron-down" size={14} color={colors.muted} />
                    </TouchableOpacity>

                    <View style={{ flex: 1 }} />

                    <View style={styles.rightControls}>
                      <TouchableOpacity style={styles.globeButton}>
                        <Ionicons name="globe-outline" size={18} color={colors.muted} />
                      </TouchableOpacity>

                      <TouchableOpacity style={styles.micButton}>
                        <Ionicons name="mic" size={18} color={colors.muted} />
                      </TouchableOpacity>
                      
                      <TouchableOpacity 
                        style={[
                          styles.sendButton, 
                          { 
                            backgroundColor: message.trim() ? colors.text : '#F3F4F6',
                          }
                        ]}
                        disabled={!message.trim()}
                      >
                        <Ionicons 
                          name="send" 
                          size={16} 
                          color={message.trim() ? colors.background : colors.muted} 
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </View>
            </Animated.View>
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>

    {/* Gmail-style Side Menu */}
    <Modal
      animationType="none"
      transparent={true}
      visible={menuModalVisible}
      onRequestClose={() => setMenuModalVisible(false)}
    >
      <Animated.View style={[styles.sideMenuOverlay, { opacity: backdropOpacityAnim }]}>
        <TouchableOpacity
          style={{ flex: 1 }}
          activeOpacity={1}
          onPress={closeMenu}
        />
        <Animated.View
          style={[
            styles.sideMenuContainer,
            {
              backgroundColor: colors.background,
              transform: [{ translateX: menuSlideAnim }],
            }
          ]}
          onStartShouldSetResponder={() => true}
        >
          {/* Menu Header */}
          <View style={[styles.sideMenuHeader, { borderBottomColor: colors.divider }]}>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
              onPress={() => {
                closeMenu();
                setTimeout(() => router.replace('/(tabs)'), 300);
              }}
            >
              <Home size={28} color={colors.text} strokeWidth={2} />
              <Text style={[styles.sideMenuTitle, { color: colors.text }]}>Home</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sideMenuContent} showsVerticalScrollIndicator={false}>
            {/* Primary Navigation */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)' as any), 300);
                }}
              >
                <Calculator size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Dashboard</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)/inbox' as any), 300);
                }}
              >
                <Inbox size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>My Inbox</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)/invoices' as any), 300);
                }}
              >
                <FileText size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Invoices</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)/banks' as any), 300);
                }}
              >
                <CreditCard size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Banks</Text>
              </TouchableOpacity>
            </View>

            {/* Divider */}
            <View style={[styles.sideMenuDivider, { backgroundColor: colors.divider }]} />

            {/* Secondary Navigation */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)/analytics' as any), 300);
                }}
              >
                <BarChart size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Analytics</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.push('/accounting/(tabs)/ledger' as any), 300);
                }}
              >
                <FileText size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Ledger</Text>
              </TouchableOpacity>
            </View>

            {/* Divider */}
            <View style={[styles.sideMenuDivider, { backgroundColor: colors.divider }]} />

            {/* Settings Section */}
            <View style={styles.sideMenuSection}>
              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={closeMenu}
              >
                <Settings size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Settings</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={closeMenu}
              >
                <HelpCircle size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Help & Support</Text>
              </TouchableOpacity>
            </View>

            {/* Footer Section */}
            <View style={[styles.sideMenuFooter]}>
              <TouchableOpacity
                style={[styles.sideMenuItem]}
                onPress={() => {
                  closeMenu();
                  setTimeout(() => router.replace('/(tabs)'), 300);
                }}
              >
                <Home size={22} color={colors.text} strokeWidth={2} />
                <Text style={[styles.sideMenuItemText, { color: colors.text }]}>Back to Home</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>

    {/* Scan Options Modal */}
    <Modal
      animationType="none"
      transparent={true}
      visible={scanModalVisible}
      onRequestClose={() => setScanModalVisible(false)}
    >
      <View style={styles.scanModalOverlay}>
        <TouchableOpacity
          style={{ flex: 1 }}
          activeOpacity={1}
          onPress={() => setScanModalVisible(false)}
        />
        <Animated.View
          style={[
            styles.scanModalContent,
            {
              backgroundColor: colors.background,
              transform: [{ translateY: scanSlideAnim }],
            }
          ]}
        >
          {/* Modal Header */}
          <View style={styles.scanModalHeader}>
            <Text style={[styles.scanModalTitle, { color: colors.text }]}>Scan Document</Text>
            <TouchableOpacity onPress={() => setScanModalVisible(false)}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Scan Options */}
          <View style={styles.scanModalOptions}>
            <TouchableOpacity
              style={[styles.scanModalOption, { borderBottomColor: colors.divider }]}
              onPress={handleScanWithCamera}
            >
              <Ionicons name="camera-outline" size={22} color={colors.text} />
              <View style={styles.scanOptionTextContainer}>
                <Text style={[styles.scanOptionTitle, { color: colors.text }]}>Scan with Camera</Text>
                <Text style={[styles.scanOptionDescription, { color: colors.muted }]}>Take a photo of receipts or invoices</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scanModalOption, { borderBottomColor: colors.divider }]}
              onPress={handleGalleryPick}
            >
              <Ionicons name="images-outline" size={22} color={colors.text} />
              <View style={styles.scanOptionTextContainer}>
                <Text style={[styles.scanOptionTitle, { color: colors.text }]}>Choose from Gallery</Text>
                <Text style={[styles.scanOptionDescription, { color: colors.muted }]}>Select existing photos from device</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.scanModalOption, { borderBottomColor: 'transparent' }]}
              onPress={handleDocumentPick}
            >
              <Ionicons name="document-outline" size={22} color={colors.text} />
              <View style={styles.scanOptionTextContainer}>
                <Text style={[styles.scanOptionTitle, { color: colors.text }]}>Upload File</Text>
                <Text style={[styles.scanOptionDescription, { color: colors.muted }]}>Upload PDF or image files</Text>
              </View>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>

    {/* Camera Modal */}
    {showCamera && (
      <Modal
        visible={showCamera}
        animationType="slide"
        onRequestClose={() => setShowCamera(false)}
      >
        <View style={styles.cameraContainer}>
          <CameraView
            style={styles.camera}
            enableTorch={flashMode === 'on'}
            ref={cameraRef}
          >
            <View style={styles.cameraOverlay}>
              {/* Top Controls */}
              <View style={styles.topControls}>
                <TouchableOpacity
                  style={styles.cameraButton}
                  onPress={() => setShowCamera(false)}
                >
                  <Ionicons name="close" size={28} color="#FFFFFF" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cameraButton}
                  onPress={() => setFlashMode(flashMode === 'off' ? 'on' : 'off')}
                >
                  <Ionicons
                    name={flashMode === 'off' ? 'flash-off' : 'flash'}
                    size={24}
                    color="#FFFFFF"
                  />
                </TouchableOpacity>
              </View>

              {/* Auto-Capture Switch */}
              <View style={styles.autoCaptureContainer}>
                <View style={styles.autoCaptureContent}>
                  <Text style={styles.autoCaptureLabel}>Auto-Capture</Text>
                  <Switch
                    value={autoCapture}
                    onValueChange={setAutoCapture}
                    trackColor={{ false: '#767577', true: '#10B981' }}
                    thumbColor={autoCapture ? '#FFFFFF' : '#f4f3f4'}
                  />
                </View>
              </View>

              {/* Dynamic Receipt Detection Overlay */}
              <View style={styles.detectionOverlay}>
                {receiptBoundaries && (() => {
                  const { width, height } = Dimensions.get('window');

                  // Convert percentage to pixels
                  const pixelPoints = receiptBoundaries.map(coord => ({
                    x: (coord.x / 100) * width,
                    y: (coord.y / 100) * height,
                  }));

                  // Generate points string for polygon
                  const pointsString = pixelPoints
                    .map(p => `${p.x},${p.y}`)
                    .join(' ');

                  const strokeColor = detectionQuality === 'good' ? '#10B981' : '#3B82F6';
                  const fillColor = detectionQuality === 'good'
                    ? 'rgba(16, 185, 129, 0.15)'
                    : 'rgba(59, 130, 246, 0.15)';

                  return (
                    <Svg
                      style={StyleSheet.absoluteFill}
                      width={width}
                      height={height}
                    >
                      {/* Semi-transparent fill */}
                      <Polygon
                        points={pointsString}
                        fill={fillColor}
                        stroke="none"
                      />

                      {/* Border lines connecting all points */}
                      {pixelPoints.map((point, index) => {
                        const nextPoint = pixelPoints[(index + 1) % pixelPoints.length];
                        return (
                          <Line
                            key={`line-${index}`}
                            x1={point.x}
                            y1={point.y}
                            x2={nextPoint.x}
                            y2={nextPoint.y}
                            stroke={strokeColor}
                            strokeWidth="3"
                          />
                        );
                      })}

                      {/* Corner circles at each vertex */}
                      {pixelPoints.map((point, index) => (
                        <Circle
                          key={`circle-${index}`}
                          cx={point.x}
                          cy={point.y}
                          r="5"
                          fill={strokeColor}
                        />
                      ))}
                    </Svg>
                  );
                })()}

                {/* Status Messages */}
                <View style={styles.statusMessageContainer}>
                  {detectionQuality === 'good' && (
                    <View style={styles.statusMessage}>
                      <Ionicons name="checkmark-circle" size={24} color="#10B981" />
                      <Text style={[styles.statusText, { color: '#10B981' }]}>
                        Perfect! {autoCapture ? 'Capturing...' : 'Tap to capture'}
                      </Text>
                    </View>
                  )}
                  {detectionQuality === 'poor' && (
                    <View style={styles.statusMessage}>
                      <Ionicons name="information-circle" size={24} color="#3B82F6" />
                      <Text style={[styles.statusText, { color: '#3B82F6' }]}>
                        Receipt detected - center for best quality
                      </Text>
                    </View>
                  )}
                  {detectionQuality === 'none' && (
                    <View style={styles.statusMessage}>
                      <Ionicons name="scan" size={24} color="rgba(255, 255, 255, 0.8)" />
                      <Text style={styles.statusText}>
                        Looking for receipt...
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              {/* Bottom Controls */}
              <View style={styles.bottomControls}>
                {!autoCapture && (
                  <TouchableOpacity
                    style={[
                      styles.captureButton,
                      detectionQuality === 'good' && styles.captureButtonReady
                    ]}
                    onPress={handleCapture}
                  >
                    <View style={styles.captureButtonInner} />
                  </TouchableOpacity>
                )}
                {autoCapture && (
                  <View style={styles.autoCaptureBadge}>
                    <Ionicons name="scan" size={20} color="#10B981" />
                    <Text style={styles.autoCaptureBadgeText}>Auto-Capture Active</Text>
                  </View>
                )}
              </View>
            </View>
          </CameraView>
        </View>
      </Modal>
    )}

    {/* Processing Modal */}
    {processing && (
      <Modal
        visible={processing}
        transparent={true}
        animationType="fade"
      >
        <View style={[styles.processingContainer, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.processingText, { color: colors.text }]}>
            Processing document...
          </Text>
          <Text style={[styles.processingSubtext, { color: colors.muted }]}>
            Extracting text and analyzing content
          </Text>
        </View>
      </Modal>
    )}
    </>
  );
}

const styles = StyleSheet.create({
  homeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 6,
  },
  homeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  menuButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalStack: {
    flex: 1,
    backgroundColor: '#1C1C1E',
  },
  previousPageContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 25,
    paddingHorizontal: 12,
  },
  previousPage: {
    height: '100%',
    borderRadius: 12,
    transform: [{ scale: 0.95 }],
    opacity: 0.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  previousPageHeader: {
    alignItems: 'center',
    paddingTop: 10,
  },
  previousPageNotch: {
    width: 36,
    height: 4,
    backgroundColor: '#8E8E93',
    borderRadius: 100,
  },
  agentContainer: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
    backgroundColor: '#FFFFFF',
  },
  agentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingTop: 20,
  },
  closeChevron: {
    padding: 8,
  },
  conversationTitle: {
    fontSize: 17,
    fontWeight: '500',
  },
  editButton: {
    padding: 8,
  },
  welcomeSection: {
    alignItems: 'center',
    marginBottom: 40,
    marginTop: 40,
  },
  agentAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  heyThere: {
    fontSize: 32,
    fontWeight: '600',
    marginBottom: 4,
  },
  howCanIHelp: {
    fontSize: 24,
    fontWeight: '500',
    marginBottom: 24,
  },
  whatsNewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  bulletPoint: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#7C3AED',
  },
  whatsNewText: {
    fontSize: 16,
  },
  suggestionPills: {
    paddingHorizontal: 20,
    gap: 12,
  },
  suggestionPill: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 24,
    borderWidth: 1,
    marginBottom: 8,
  },
  suggestionPillText: {
    fontSize: 15,
    textAlign: 'center',
  },
  inputBar: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  inputBarFixed: {
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 10,
  },
  inputContainer: {
    flexDirection: 'column',
    gap: 8,
  },
  inputFieldWrapper: {
    width: '100%',
    paddingHorizontal: 8,
  },
  agentInput: {
    fontSize: 16,
    lineHeight: 22,
    minHeight: 40,
    maxHeight: 200,
    paddingHorizontal: 12,
    paddingVertical: 8,
    textAlignVertical: 'top',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  plusButton: {
    padding: 6,
    borderRadius: 8,
  },
  sourcesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  sourcesText: {
    fontSize: 14,
    fontWeight: '500',
  },
  rightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  globeButton: {
    padding: 8,
    borderRadius: 8,
  },
  micButton: {
    padding: 8,
    borderRadius: 8,
  },
  sendButton: {
    padding: 8,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sideMenuContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 320,
  },
  sideMenuHeader: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  sideMenuTitle: {
    fontSize: 24,
    fontWeight: '600',
  },
  sideMenuContent: {
    flex: 1,
  },
  sideMenuSection: {
    paddingVertical: 8,
  },
  sideMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 16,
  },
  sideMenuItemText: {
    fontSize: 15,
    fontWeight: '500',
  },
  sideMenuDivider: {
    height: 1,
    marginVertical: 8,
  },
  sideMenuFooter: {
    paddingVertical: 16,
    marginTop: 20,
  },
  scanModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  scanModalContent: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingBottom: 30,
  },
  scanModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  scanModalTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  scanModalOptions: {
    paddingTop: 4,
  },
  scanModalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 16,
    borderBottomWidth: 1,
  },
  scanOptionTextContainer: {
    flex: 1,
    gap: 2,
  },
  scanOptionTitle: {
    fontSize: 16,
    fontWeight: '400',
  },
  scanOptionDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
  },
  topControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 40,
    paddingTop: 60,
  },
  autoCaptureContainer: {
    alignItems: 'center',
    paddingHorizontal: 20,
    marginTop: -20,
  },
  autoCaptureContent: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 12,
  },
  autoCaptureLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  cameraButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  detectionOverlay: {
    flex: 1,
    position: 'relative',
  },
  statusMessageContainer: {
    position: 'absolute',
    top: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  statusMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    gap: 10,
  },
  statusText: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 14,
    fontWeight: '500',
  },
  bottomControls: {
    paddingBottom: 40,
    alignItems: 'center',
  },
  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#FFFFFF',
  },
  captureButtonReady: {
    backgroundColor: 'rgba(16, 185, 129, 0.4)',
  },
  autoCaptureBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    gap: 8,
  },
  autoCaptureBadgeText: {
    color: '#10B981',
    fontSize: 14,
    fontWeight: '600',
  },
  processingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  processingText: {
    marginTop: 16,
    fontSize: 16,
    fontWeight: '600',
  },
  processingSubtext: {
    marginTop: 4,
    fontSize: 13,
  },
});