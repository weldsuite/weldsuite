import { Tabs } from "expo-router";
import React, { useState, useEffect, useRef } from "react";
import { Home, Package, Truck, ChevronLeft, BarChart, Search, History, Bell } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, Modal, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, Easing, Keyboard, LayoutAnimation, UIManager, Dimensions, TouchableWithoutFeedback, Alert } from 'react-native';
import { router } from 'expo-router';
import WeldAgentLogo from '@/components/WeldAgentLogo';
import ParcelSidebar from '@/components/ParcelSidebar';

// Enable LayoutAnimation on Android (only needed for old architecture)
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental &&
  !(global as any).__turboModuleProxy
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function ParcelTabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(1000)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const keyboardHeight = useRef(new Animated.Value(0)).current;

  // Detect iPad - only check window width and ensure it's not being run on web
  const { width } = Dimensions.get('window');
  const isTablet = Platform.OS === 'ios' && width >= 768; // iPad width threshold, iOS only
  
  // For debugging
  if (__DEV__) {
    console.log('Device detection:', {
      windowWidth: width,
      isTablet,
      platform: Platform.OS
    });
  }

  // Keyboard animation listeners for WhatsApp-like smooth transitions
  useEffect(() => {
    // Only set up keyboard listeners if the agent modal is visible
    if (!agentModalVisible) return;

    const showListener = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
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
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
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
  }, [agentModalVisible]);

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

  const HeaderLeft = () => (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TouchableOpacity
          onPress={() => router.replace('/(tabs)')}
          style={styles.homeButton}
        >
          <Home size={18} color="#374151" strokeWidth={2} />
          <Text style={styles.homeButtonText}>Home</Text>
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              backgroundColor: '#059669',
              borderRadius: 8,
              width: 36,
              height: 36,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Truck size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>Parcel Tracking</Text>
        </View>
      </View>
  );

  // AI (WeldAgent) has been removed along with the AI backend — the button
  // now surfaces an unavailable notice instead of opening the agent overlay.
  const HeaderRight = () => (
    <TouchableOpacity
      style={{ marginRight: 16 }}
      onPress={() => Alert.alert('AI unavailable', 'AI is currently unavailable.')}
    >
      <WeldAgentLogo size={20} color="#000000" />
    </TouchableOpacity>
  );

  // Render sidebar layout for tablets
  if (isTablet) {
    const HeaderCenterTablet = () => {
      const [searchText, setSearchText] = useState('');
      const [isFocused, setIsFocused] = useState(false);
      const searchInputRef = useRef<TextInput>(null);
      
      return (
        <TouchableWithoutFeedback onPress={() => searchInputRef.current?.focus()}>
          <View style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 6,
          }}>
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: '#F3F4F6',
              borderRadius: 8,
              paddingHorizontal: 12,
              height: 40,
              width: 340,
            }}>
              <Search size={18} color="#9CA3AF" strokeWidth={2} />
              <TextInput
                ref={searchInputRef}
                style={{
                  flex: 1,
                  marginLeft: 10,
                  fontSize: 15,
                  color: colors.text,
                  paddingVertical: 4,
                }}
                placeholder="Search parcels, tracking numbers..."
                placeholderTextColor="#9CA3AF"
                value={searchText}
                onChangeText={setSearchText}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                keyboardType="default"
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                editable={true}
                selectTextOnFocus={false}
              />
            </View>
          </View>
        </TouchableWithoutFeedback>
      );
    };

    const HeaderRightTablet = () => (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <TouchableOpacity 
          onPress={() => {}}
          style={{
            width: 32,
            height: 32,
            borderWidth: 1,
            borderColor: '#E5E7EB',
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Bell size={18} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Alert.alert('AI unavailable', 'AI is currently unavailable.')}>
          <WeldAgentLogo size={20} color="#000000" />
        </TouchableOpacity>
      </View>
    );

    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.background }}>
        {/* Sidebar */}
        <ParcelSidebar />
        
        {/* Main Content */}
        <View style={{ flex: 1 }}>
          <Tabs
            screenOptions={{
              tabBarActiveTintColor: colors.text,
              tabBarInactiveTintColor: colors.muted,
              headerShown: true,
              headerStyle: {
                backgroundColor: colors.background,
                borderBottomWidth: 0.5,
                borderBottomColor: '#E5E7EB',
                height: 80,
              },
              headerShadowVisible: false,
              headerTintColor: colors.text,
              headerLeft: () => null,
              headerTitle: () => <HeaderCenterTablet />,
              headerTitleContainerStyle: {
                left: 0,
                right: 0,
                position: 'absolute',
                width: '100%',
              },
              headerRight: HeaderRightTablet,
              headerRightContainerStyle: {
                position: 'absolute',
                right: 16,
                zIndex: 10,
              },
              tabBarStyle: { display: 'none' }, // Hide tab bar on iPad
            }}
          >
            <Tabs.Screen
              name="index"
              options={{
                title: "Dashboard",
              }}
            />

            <Tabs.Screen
              name="orders"
              options={{
                title: "Orders",
              }}
            />

            <Tabs.Screen
              name="pickups"
              options={{
                title: "Pickups",
              }}
            />

            <Tabs.Screen
              name="returns"
              options={{
                title: "Returns",
              }}
            />

            <Tabs.Screen
              name="scan"
              options={{
                title: "Scan",
              }}
            />

            <Tabs.Screen
              name="parcels"
              options={{
                title: "Parcels",
              }}
            />

            <Tabs.Screen
              name="boxes"
              options={{
                title: "Boxes",
              }}
            />

            <Tabs.Screen
              name="shipping-prices"
              options={{
                title: "Shipping Prices",
              }}
            />
          </Tabs>
          
          {/* WeldAgent Overlay for iPad */}
          <Modal
            animationType="none"
            transparent={true}
            visible={agentModalVisible}
            onRequestClose={() => setAgentModalVisible(false)}
            presentationStyle="overFullScreen"
            statusBarTranslucent={true}
          >
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
              <TouchableOpacity 
                style={{ flex: 1 }}
                activeOpacity={1}
                onPress={() => setAgentModalVisible(false)}
              >
                <View />
              </TouchableOpacity>
              
              <Animated.View 
                style={[
                  styles.agentContainerTablet,
                  { 
                    backgroundColor: colors.background,
                    transform: [{ translateY: slideAnim }],
                    opacity: fadeAnim,
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
                      <Text style={[styles.suggestionPillText, { color: colors.text }]}>Track my parcel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                      <Text style={[styles.suggestionPillText, { color: colors.text }]}>Show delivery status</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                      <Text style={[styles.suggestionPillText, { color: colors.text }]}>Find nearest drop-off</Text>
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
            </View>
          </Modal>
        </View>
      </View>
    );
  }

  // Default mobile layout
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
          fontWeight: '500',
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
            <Home size={20} color={color} strokeWidth={2} />
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
      />

      <Tabs.Screen
        name="parcels"
        options={{
          title: "Parcels",
          tabBarIcon: ({ color, size }) => (
            <Package size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      {/* Hide iPad-only screens from mobile */}
      <Tabs.Screen name="orders" options={{ href: null }} />
      <Tabs.Screen name="pickups" options={{ href: null }} />
      <Tabs.Screen name="returns" options={{ href: null }} />
      <Tabs.Screen name="boxes" options={{ href: null }} />
      <Tabs.Screen name="shipping-prices" options={{ href: null }} />
      <Tabs.Screen name="analytics" options={{ href: null }} />

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
                    <Text style={[styles.suggestionPillText, { color: colors.text }]}>Track my parcel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                    <Text style={[styles.suggestionPillText, { color: colors.text }]}>Show delivery status</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                    <Text style={[styles.suggestionPillText, { color: colors.text }]}>Find nearest drop-off</Text>
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
  agentContainerTablet: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 400,
    height: 600,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
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
});