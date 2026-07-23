import { Tabs } from "expo-router";
import React, { useState, useEffect, useRef } from "react";
import { Home, Package, ListChecks, Layers3, ChevronLeft } from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TouchableOpacity, Text, View, Modal, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, Easing, Alert } from 'react-native';
import { router } from 'expo-router';
import WeldAgentLogo from '@/components/WeldAgentLogo';

export default function WmsTabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [message, setMessage] = useState('');
  const slideAnim = useRef(new Animated.Value(1000)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

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
            backgroundColor: '#000000',
            borderRadius: 8,
            width: 36,
            height: 36,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Package size={20} color="#FFFFFF" strokeWidth={2} />
        </View>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>WMS</Text>
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
            <Home size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="inventory"
        options={{
          title: "Products",
          tabBarIcon: ({ color, size }) => (
            <Package size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="picklists"
        options={{
          title: "Picklists",
          tabBarIcon: ({ color, size }) => (
            <ListChecks size={20} color={color} strokeWidth={2} />
          ),
        }}
      />

      <Tabs.Screen
        name="analytics"
        options={{
          title: "Batches",
          tabBarIcon: ({ color, size }) => (
            <Layers3 size={20} color={color} strokeWidth={2} />
          ),
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
    >
      <Animated.View style={[styles.modalStack, { opacity: fadeAnim }]}>
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
        
        {/* Agent Container with animation */}
        <Animated.View 
          style={[
            styles.agentContainer, 
            { 
              backgroundColor: colors.background,
              transform: [{ translateY: slideAnim }]
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

        {/* Agent Content */}
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView 
            style={styles.agentBody} 
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.agentContentContainer}
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
                <Text style={[styles.suggestionPillText, { color: colors.text }]}>Show inventory status report</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.suggestionPill, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}>
                <Text style={[styles.suggestionPillText, { color: colors.text }]}>Check pending shipments</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

          {/* Input Bar */}
          <View style={[styles.inputBar, { backgroundColor: colors.background }]}>
            <View style={styles.inputRow}>
              <TouchableOpacity style={styles.attachButton}>
                <Ionicons name="attach" size={24} color={colors.muted} />
              </TouchableOpacity>
              <View style={[styles.inputWrapper, { backgroundColor: '#F3F4F6' }]}>
                <TextInput
                  style={[styles.agentInput, { color: colors.text }]}
                  placeholder="Ask anything..."
                  placeholderTextColor={colors.muted}
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  maxLength={500}
                />
              </View>
              <TouchableOpacity 
                style={styles.micButton}
              >
                <Ionicons name="mic" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
      </Animated.View>
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
    position: 'absolute',
    top: 55,
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
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
  agentBody: {
    flex: 1,
  },
  agentContentContainer: {
    padding: 24,
    paddingBottom: 100,
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
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingVertical: 12,
    paddingBottom: 28,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  attachButton: {
    padding: 8,
  },
  inputWrapper: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  agentInput: {
    fontSize: 16,
    maxHeight: 100,
  },
  micButton: {
    padding: 8,
  },
});