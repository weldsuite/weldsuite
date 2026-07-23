"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Settings,
  Users,
  Building2,
  Lock,
  Key,
  Database,
  Server,
  Globe,
  Shield,
  AlertCircle,
  CreditCard,
  TrendingUp,
  FileText,
  Bell,
  UserCheck,
  HelpCircle,
  Home,
  Search,
  Palette,
  Languages,
  FileDown,
  Trash2,
  Moon,
  Sun,
  Monitor,
  Check,
  ChevronRight,
  Volume2,
  VolumeX,
  Mail,
  Smartphone,
  Wifi,
  WifiOff,
  Eye,
  EyeOff,
  Download,
  Upload,
  RefreshCw,
  Save,
  X,
  Laptop,
  Cloud,
  Zap,
  Activity,
  Archive,
  BarChart3,
  Calendar,
  Clock,
  Cpu,
  HardDrive,
  Headphones,
  Info,
  Layers,
  Link,
  LogOut,
  MessageSquare,
  Mic,
  Package,
  Paperclip,
  Play,
  Power,
  Printer,
  Radio,
  Rss,
  Share2,
  Sliders,
  Tag,
  Terminal,
  Trash,
  User,
  Video,
  Webhook,
  Wrench,
} from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Button } from "./button"
import { Switch } from "./switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { Slider } from "./slider"
import { Label } from "./label"
import { Input } from "./input"
import { Textarea } from "./textarea"
import { Badge } from "./badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Separator } from "./separator"
import { ScrollArea } from "./scroll-area"
import { RadioGroup, RadioGroupItem } from "./radio-group"
import { Checkbox } from "./checkbox"
import { cn } from "../lib/utils"
import { toast } from "sonner"

interface SettingsCommandProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

// Settings state management
const useSettingsState = () => {
  // Load initial state from localStorage
  const loadSetting = (key: string, defaultValue: any) => {
    if (typeof window === 'undefined') return defaultValue
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        return JSON.parse(stored)
      } catch {
        return defaultValue
      }
    }
    return defaultValue
  }

  // Appearance Settings
  const [theme, setTheme] = React.useState<"light" | "dark" | "system">(() => 
    loadSetting('theme', 'system')
  )
  const [language, setLanguage] = React.useState(() => 
    loadSetting('language', 'en')
  )
  const [fontSize, setFontSize] = React.useState(() => 
    loadSetting('fontSize', 100)
  )
  const [fontFamily, setFontFamily] = React.useState(() => 
    loadSetting('fontFamily', 'system')
  )
  const [accentColor, setAccentColor] = React.useState(() => 
    loadSetting('accentColor', 'blue')
  )
  const [density, setDensity] = React.useState(() => 
    loadSetting('density', 'normal')
  )

  // Notification Settings
  const [notifications, setNotifications] = React.useState(() => 
    loadSetting('notifications', {
      email: true,
      push: true,
      desktop: true,
      sound: true,
      vibration: true,
      doNotDisturb: false,
      doNotDisturbStart: '22:00',
      doNotDisturbEnd: '07:00',
      emailDigest: 'daily',
      categories: {
        security: true,
        updates: true,
        social: false,
        marketing: false,
        system: true,
        billing: true,
      }
    })
  )

  // Privacy Settings
  const [privacy, setPrivacy] = React.useState(() => 
    loadSetting('privacy', {
      analytics: true,
      crashReports: true,
      marketing: false,
      personalizedAds: false,
      dataSharing: false,
      searchHistory: true,
      activityStatus: true,
      profileVisibility: 'public',
      contactSync: false,
      locationServices: false,
    })
  )

  // Security Settings
  const [security, setSecurity] = React.useState(() => 
    loadSetting('security', {
      twoFactor: false,
      twoFactorMethod: 'app',
      sessionTimeout: 30,
      autoLock: true,
      autoLockDelay: 5,
      passwordExpiry: 90,
      loginAlerts: true,
      trustedDevices: [],
      apiAccess: true,
      ipWhitelist: false,
      ipAddresses: '',
    })
  )

  // Accessibility Settings
  const [accessibility, setAccessibility] = React.useState(() => 
    loadSetting('accessibility', {
      reduceMotion: false,
      highContrast: false,
      screenReader: false,
      keyboardNavigation: true,
      focusIndicators: true,
      colorBlindMode: 'none',
      textToSpeech: false,
      speechRate: 1,
      captions: true,
      transcripts: true,
    })
  )

  // Data & Storage Settings
  const [dataStorage, setDataStorage] = React.useState(() => 
    loadSetting('dataStorage', {
      autoBackup: true,
      backupFrequency: 'daily',
      backupLocation: 'cloud',
      cacheSize: 100,
      offlineMode: true,
      syncEnabled: true,
      compressionLevel: 'medium',
      retentionPeriod: 30,
      autoDelete: false,
    })
  )

  // Integration Settings
  const [integrations, setIntegrations] = React.useState(() => 
    loadSetting('integrations', {
      slack: { enabled: false, webhook: '' },
      discord: { enabled: false, webhook: '' },
      github: { enabled: false, token: '' },
      google: { enabled: false, clientId: '' },
      microsoft: { enabled: false, tenantId: '' },
      zapier: { enabled: false, apiKey: '' },
      webhook: { enabled: false, url: '', secret: '' },
    })
  )

  // Advanced Settings
  const [advanced, setAdvanced] = React.useState(() => 
    loadSetting('advanced', {
      developerMode: false,
      betaFeatures: false,
      performanceMode: 'balanced',
      debugLogging: false,
      telemetry: true,
      experimentalFeatures: false,
      customCSS: '',
      customJS: '',
      apiRateLimit: 100,
      maxUploadSize: 10,
      connectionTimeout: 30,
    })
  )

  // Save settings to localStorage
  const saveSetting = (key: string, value: any) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value))
    }
  }

  // Watch for changes and save
  React.useEffect(() => { saveSetting('theme', theme) }, [theme])
  React.useEffect(() => { saveSetting('language', language) }, [language])
  React.useEffect(() => { saveSetting('fontSize', fontSize) }, [fontSize])
  React.useEffect(() => { saveSetting('fontFamily', fontFamily) }, [fontFamily])
  React.useEffect(() => { saveSetting('accentColor', accentColor) }, [accentColor])
  React.useEffect(() => { saveSetting('density', density) }, [density])
  React.useEffect(() => { saveSetting('notifications', notifications) }, [notifications])
  React.useEffect(() => { saveSetting('privacy', privacy) }, [privacy])
  React.useEffect(() => { saveSetting('security', security) }, [security])
  React.useEffect(() => { saveSetting('accessibility', accessibility) }, [accessibility])
  React.useEffect(() => { saveSetting('dataStorage', dataStorage) }, [dataStorage])
  React.useEffect(() => { saveSetting('integrations', integrations) }, [integrations])
  React.useEffect(() => { saveSetting('advanced', advanced) }, [advanced])

  return {
    theme, setTheme,
    language, setLanguage,
    fontSize, setFontSize,
    fontFamily, setFontFamily,
    accentColor, setAccentColor,
    density, setDensity,
    notifications, setNotifications,
    privacy, setPrivacy,
    security, setSecurity,
    accessibility, setAccessibility,
    dataStorage, setDataStorage,
    integrations, setIntegrations,
    advanced, setAdvanced,
  }
}

export function SettingsCommand({
  open = false,
  onOpenChange,
}: SettingsCommandProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = React.useState("appearance")
  const [hasChanges, setHasChanges] = React.useState(false)
  const state = useSettingsState()

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        onOpenChange?.(!open)
      }
    }

    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [open, onOpenChange])

  const handleSave = () => {
    // Apply theme changes
    document.documentElement.setAttribute('data-theme', state.theme)
    document.documentElement.style.fontSize = `${state.fontSize}%`
    
    setHasChanges(false)
    toast.success("Settings saved", {
      description: "Your settings have been updated successfully.",
    })
  }

  const handleReset = (category: string) => {
    if (confirm(`Reset all ${category} settings to defaults?`)) {
      // Reset logic here
      toast.info("Settings reset", {
        description: `${category} settings have been reset to defaults.`,
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[80vh] p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="text-2xl">Settings</DialogTitle>
          <DialogDescription>
            Configure your application preferences and settings
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <div className="px-6">
            <TabsList className="grid w-full grid-cols-8">
              <TabsTrigger value="appearance" className="text-xs">
                <Palette className="h-4 w-4 mr-1" />
                Appearance
              </TabsTrigger>
              <TabsTrigger value="notifications" className="text-xs">
                <Bell className="h-4 w-4 mr-1" />
                Notifications
              </TabsTrigger>
              <TabsTrigger value="privacy" className="text-xs">
                <Eye className="h-4 w-4 mr-1" />
                Privacy
              </TabsTrigger>
              <TabsTrigger value="security" className="text-xs">
                <Shield className="h-4 w-4 mr-1" />
                Security
              </TabsTrigger>
              <TabsTrigger value="accessibility" className="text-xs">
                <Settings className="h-4 w-4 mr-1" />
                Accessibility
              </TabsTrigger>
              <TabsTrigger value="data" className="text-xs">
                <Database className="h-4 w-4 mr-1" />
                Data
              </TabsTrigger>
              <TabsTrigger value="integrations" className="text-xs">
                <Link className="h-4 w-4 mr-1" />
                Integrations
              </TabsTrigger>
              <TabsTrigger value="advanced" className="text-xs">
                <Wrench className="h-4 w-4 mr-1" />
                Advanced
              </TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1 px-6">
            {/* Appearance Tab */}
            <TabsContent value="appearance" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Theme & Colors</CardTitle>
                  <CardDescription>Customize the look and feel of your application</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="theme">Color Theme</Label>
                    <RadioGroup value={state.theme} onValueChange={(v: any) => { state.setTheme(v); setHasChanges(true) }}>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="light" id="light" />
                        <Label htmlFor="light" className="flex items-center gap-2">
                          <Sun className="h-4 w-4" />
                          Light
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="dark" id="dark" />
                        <Label htmlFor="dark" className="flex items-center gap-2">
                          <Moon className="h-4 w-4" />
                          Dark
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="system" id="system" />
                        <Label htmlFor="system" className="flex items-center gap-2">
                          <Monitor className="h-4 w-4" />
                          System
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accent">Accent Color</Label>
                    <Select value={state.accentColor} onValueChange={(v) => { state.setAccentColor(v); setHasChanges(true) }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="blue">Blue</SelectItem>
                        <SelectItem value="green">Green</SelectItem>
                        <SelectItem value="purple">Purple</SelectItem>
                        <SelectItem value="red">Red</SelectItem>
                        <SelectItem value="orange">Orange</SelectItem>
                        <SelectItem value="pink">Pink</SelectItem>
                        <SelectItem value="cyan">Cyan</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="density">UI Density</Label>
                    <Select value={state.density} onValueChange={(v) => { state.setDensity(v); setHasChanges(true) }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compact</SelectItem>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="comfortable">Comfortable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Typography</CardTitle>
                  <CardDescription>Adjust text appearance and readability</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="language">Language</Label>
                    <Select value={state.language} onValueChange={(v) => { state.setLanguage(v); setHasChanges(true) }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="es">Español</SelectItem>
                        <SelectItem value="fr">Français</SelectItem>
                        <SelectItem value="de">Deutsch</SelectItem>
                        <SelectItem value="ja">日本語</SelectItem>
                        <SelectItem value="zh">中文</SelectItem>
                        <SelectItem value="ko">한국어</SelectItem>
                        <SelectItem value="pt">Português</SelectItem>
                        <SelectItem value="ru">Русский</SelectItem>
                        <SelectItem value="ar">العربية</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fontSize">Font Size: {state.fontSize}%</Label>
                    <Slider 
                      value={[state.fontSize]} 
                      onValueChange={(v) => { state.setFontSize(v[0]); setHasChanges(true) }}
                      min={80} 
                      max={120} 
                      step={5}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fontFamily">Font Family</Label>
                    <Select value={state.fontFamily} onValueChange={(v) => { state.setFontFamily(v); setHasChanges(true) }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="system">System Default</SelectItem>
                        <SelectItem value="inter">Inter</SelectItem>
                        <SelectItem value="roboto">Roboto</SelectItem>
                        <SelectItem value="opensans">Open Sans</SelectItem>
                        <SelectItem value="lato">Lato</SelectItem>
                        <SelectItem value="poppins">Poppins</SelectItem>
                        <SelectItem value="mono">Monospace</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => handleReset('Appearance')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Notifications Tab */}
            <TabsContent value="notifications" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Notification Channels</CardTitle>
                  <CardDescription>Choose how you want to receive notifications</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="email-notif">Email Notifications</Label>
                      <p className="text-sm text-muted-foreground">Receive notifications via email</p>
                    </div>
                    <Switch
                      id="email-notif"
                      checked={state.notifications.email}
                      onCheckedChange={(v) => {
                        state.setNotifications({ ...state.notifications, email: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="push-notif">Push Notifications</Label>
                      <p className="text-sm text-muted-foreground">Receive push notifications on your devices</p>
                    </div>
                    <Switch
                      id="push-notif"
                      checked={state.notifications.push}
                      onCheckedChange={(v) => {
                        state.setNotifications({ ...state.notifications, push: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="desktop-notif">Desktop Notifications</Label>
                      <p className="text-sm text-muted-foreground">Show notifications on your desktop</p>
                    </div>
                    <Switch
                      id="desktop-notif"
                      checked={state.notifications.desktop}
                      onCheckedChange={(v) => {
                        state.setNotifications({ ...state.notifications, desktop: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="sound-notif">Notification Sound</Label>
                      <p className="text-sm text-muted-foreground">Play sound for notifications</p>
                    </div>
                    <Switch
                      id="sound-notif"
                      checked={state.notifications.sound}
                      onCheckedChange={(v) => {
                        state.setNotifications({ ...state.notifications, sound: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Do Not Disturb</CardTitle>
                  <CardDescription>Set quiet hours for notifications</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="dnd">Enable Do Not Disturb</Label>
                      <p className="text-sm text-muted-foreground">Mute notifications during specified hours</p>
                    </div>
                    <Switch
                      id="dnd"
                      checked={state.notifications.doNotDisturb}
                      onCheckedChange={(v) => {
                        state.setNotifications({ ...state.notifications, doNotDisturb: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  {state.notifications.doNotDisturb && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="dnd-start">Start Time</Label>
                        <Input
                          id="dnd-start"
                          type="time"
                          value={state.notifications.doNotDisturbStart}
                          onChange={(e) => {
                            state.setNotifications({ ...state.notifications, doNotDisturbStart: e.target.value })
                            setHasChanges(true)
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="dnd-end">End Time</Label>
                        <Input
                          id="dnd-end"
                          type="time"
                          value={state.notifications.doNotDisturbEnd}
                          onChange={(e) => {
                            state.setNotifications({ ...state.notifications, doNotDisturbEnd: e.target.value })
                            setHasChanges(true)
                          }}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Notification Categories</CardTitle>
                  <CardDescription>Choose which types of notifications to receive</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {Object.entries(state.notifications.categories).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between">
                      <Label htmlFor={`cat-${key}`} className="capitalize">{key}</Label>
                      <Switch
                        id={`cat-${key}`}
                        checked={value}
                        onCheckedChange={(v) => {
                          state.setNotifications({
                            ...state.notifications,
                            categories: { ...state.notifications.categories, [key]: v }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => handleReset('Notifications')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Privacy Tab */}
            <TabsContent value="privacy" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Data Collection</CardTitle>
                  <CardDescription>Control how your data is collected and used</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="analytics">Analytics</Label>
                      <p className="text-sm text-muted-foreground">Help improve our products with usage data</p>
                    </div>
                    <Switch
                      id="analytics"
                      checked={state.privacy.analytics}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, analytics: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="crash">Crash Reports</Label>
                      <p className="text-sm text-muted-foreground">Send crash reports to help fix bugs</p>
                    </div>
                    <Switch
                      id="crash"
                      checked={state.privacy.crashReports}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, crashReports: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="marketing">Marketing Communications</Label>
                      <p className="text-sm text-muted-foreground">Receive marketing emails and updates</p>
                    </div>
                    <Switch
                      id="marketing"
                      checked={state.privacy.marketing}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, marketing: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="ads">Personalized Ads</Label>
                      <p className="text-sm text-muted-foreground">Show ads based on your activity</p>
                    </div>
                    <Switch
                      id="ads"
                      checked={state.privacy.personalizedAds}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, personalizedAds: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Profile & Activity</CardTitle>
                  <CardDescription>Manage your profile visibility and activity status</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="visibility">Profile Visibility</Label>
                    <Select 
                      value={state.privacy.profileVisibility} 
                      onValueChange={(v) => {
                        state.setPrivacy({ ...state.privacy, profileVisibility: v })
                        setHasChanges(true)
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="friends">Friends Only</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="activity">Activity Status</Label>
                      <p className="text-sm text-muted-foreground">Show when you're online</p>
                    </div>
                    <Switch
                      id="activity"
                      checked={state.privacy.activityStatus}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, activityStatus: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="search">Search History</Label>
                      <p className="text-sm text-muted-foreground">Save your search history</p>
                    </div>
                    <Switch
                      id="search"
                      checked={state.privacy.searchHistory}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, searchHistory: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="location">Location Services</Label>
                      <p className="text-sm text-muted-foreground">Allow apps to use your location</p>
                    </div>
                    <Switch
                      id="location"
                      checked={state.privacy.locationServices}
                      onCheckedChange={(v) => {
                        state.setPrivacy({ ...state.privacy, locationServices: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end gap-2">
                <Button variant="outline">Export My Data</Button>
                <Button variant="outline" onClick={() => handleReset('Privacy')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Security Tab */}
            <TabsContent value="security" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Authentication</CardTitle>
                  <CardDescription>Manage your authentication settings</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="2fa">Two-Factor Authentication</Label>
                      <p className="text-sm text-muted-foreground">Add an extra layer of security</p>
                    </div>
                    <Switch
                      id="2fa"
                      checked={state.security.twoFactor}
                      onCheckedChange={(v) => {
                        state.setSecurity({ ...state.security, twoFactor: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  {state.security.twoFactor && (
                    <div className="space-y-2">
                      <Label htmlFor="2fa-method">2FA Method</Label>
                      <Select 
                        value={state.security.twoFactorMethod} 
                        onValueChange={(v) => {
                          state.setSecurity({ ...state.security, twoFactorMethod: v })
                          setHasChanges(true)
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="app">Authenticator App</SelectItem>
                          <SelectItem value="sms">SMS</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="timeout">Session Timeout (minutes): {state.security.sessionTimeout}</Label>
                    <Slider
                      id="timeout"
                      value={[state.security.sessionTimeout]}
                      onValueChange={(v) => {
                        state.setSecurity({ ...state.security, sessionTimeout: v[0] })
                        setHasChanges(true)
                      }}
                      min={5}
                      max={120}
                      step={5}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="autolock">Auto Lock</Label>
                      <p className="text-sm text-muted-foreground">Lock screen when idle</p>
                    </div>
                    <Switch
                      id="autolock"
                      checked={state.security.autoLock}
                      onCheckedChange={(v) => {
                        state.setSecurity({ ...state.security, autoLock: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="alerts">Login Alerts</Label>
                      <p className="text-sm text-muted-foreground">Get notified of new sign-ins</p>
                    </div>
                    <Switch
                      id="alerts"
                      checked={state.security.loginAlerts}
                      onCheckedChange={(v) => {
                        state.setSecurity({ ...state.security, loginAlerts: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Password Policy</CardTitle>
                  <CardDescription>Configure password requirements</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="expiry">Password Expiry (days): {state.security.passwordExpiry}</Label>
                    <Slider
                      id="expiry"
                      value={[state.security.passwordExpiry]}
                      onValueChange={(v) => {
                        state.setSecurity({ ...state.security, passwordExpiry: v[0] })
                        setHasChanges(true)
                      }}
                      min={30}
                      max={365}
                      step={30}
                    />
                  </div>

                  <Button variant="outline" className="w-full">Change Password</Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>API Access</CardTitle>
                  <CardDescription>Manage API access and restrictions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="api">Enable API Access</Label>
                      <p className="text-sm text-muted-foreground">Allow API access to your account</p>
                    </div>
                    <Switch
                      id="api"
                      checked={state.security.apiAccess}
                      onCheckedChange={(v) => {
                        state.setSecurity({ ...state.security, apiAccess: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="whitelist">IP Whitelist</Label>
                      <p className="text-sm text-muted-foreground">Restrict access to specific IP addresses</p>
                    </div>
                    <Switch
                      id="whitelist"
                      checked={state.security.ipWhitelist}
                      onCheckedChange={(v) => {
                        state.setSecurity({ ...state.security, ipWhitelist: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  {state.security.ipWhitelist && (
                    <div className="space-y-2">
                      <Label htmlFor="ips">Whitelisted IP Addresses</Label>
                      <Textarea
                        id="ips"
                        placeholder="Enter IP addresses (one per line)"
                        value={state.security.ipAddresses}
                        onChange={(e) => {
                          state.setSecurity({ ...state.security, ipAddresses: e.target.value })
                          setHasChanges(true)
                        }}
                        className="h-24"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="flex justify-end gap-2">
                <Button variant="outline">View Security Log</Button>
                <Button variant="outline" onClick={() => handleReset('Security')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Accessibility Tab */}
            <TabsContent value="accessibility" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Visual</CardTitle>
                  <CardDescription>Adjust visual accessibility features</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="motion">Reduce Motion</Label>
                      <p className="text-sm text-muted-foreground">Minimize animations and transitions</p>
                    </div>
                    <Switch
                      id="motion"
                      checked={state.accessibility.reduceMotion}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, reduceMotion: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="contrast">High Contrast</Label>
                      <p className="text-sm text-muted-foreground">Increase color contrast</p>
                    </div>
                    <Switch
                      id="contrast"
                      checked={state.accessibility.highContrast}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, highContrast: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="colorblind">Color Blind Mode</Label>
                    <Select 
                      value={state.accessibility.colorBlindMode} 
                      onValueChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, colorBlindMode: v })
                        setHasChanges(true)
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="protanopia">Protanopia</SelectItem>
                        <SelectItem value="deuteranopia">Deuteranopia</SelectItem>
                        <SelectItem value="tritanopia">Tritanopia</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="focus">Focus Indicators</Label>
                      <p className="text-sm text-muted-foreground">Show clear focus indicators</p>
                    </div>
                    <Switch
                      id="focus"
                      checked={state.accessibility.focusIndicators}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, focusIndicators: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Audio & Speech</CardTitle>
                  <CardDescription>Configure audio and speech features</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="reader">Screen Reader</Label>
                      <p className="text-sm text-muted-foreground">Enable screen reader support</p>
                    </div>
                    <Switch
                      id="reader"
                      checked={state.accessibility.screenReader}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, screenReader: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="tts">Text to Speech</Label>
                      <p className="text-sm text-muted-foreground">Read content aloud</p>
                    </div>
                    <Switch
                      id="tts"
                      checked={state.accessibility.textToSpeech}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, textToSpeech: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  {state.accessibility.textToSpeech && (
                    <div className="space-y-2">
                      <Label htmlFor="rate">Speech Rate: {state.accessibility.speechRate}x</Label>
                      <Slider
                        id="rate"
                        value={[state.accessibility.speechRate]}
                        onValueChange={(v) => {
                          state.setAccessibility({ ...state.accessibility, speechRate: v[0] })
                          setHasChanges(true)
                        }}
                        min={0.5}
                        max={2}
                        step={0.1}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="captions">Captions</Label>
                      <p className="text-sm text-muted-foreground">Show captions for media</p>
                    </div>
                    <Switch
                      id="captions"
                      checked={state.accessibility.captions}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, captions: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Navigation</CardTitle>
                  <CardDescription>Keyboard and navigation settings</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="keyboard">Keyboard Navigation</Label>
                      <p className="text-sm text-muted-foreground">Navigate using keyboard only</p>
                    </div>
                    <Switch
                      id="keyboard"
                      checked={state.accessibility.keyboardNavigation}
                      onCheckedChange={(v) => {
                        state.setAccessibility({ ...state.accessibility, keyboardNavigation: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => handleReset('Accessibility')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Data & Storage Tab */}
            <TabsContent value="data" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Backup & Sync</CardTitle>
                  <CardDescription>Manage your data backup and synchronization</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="backup">Auto Backup</Label>
                      <p className="text-sm text-muted-foreground">Automatically backup your data</p>
                    </div>
                    <Switch
                      id="backup"
                      checked={state.dataStorage.autoBackup}
                      onCheckedChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, autoBackup: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  {state.dataStorage.autoBackup && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="frequency">Backup Frequency</Label>
                        <Select 
                          value={state.dataStorage.backupFrequency} 
                          onValueChange={(v) => {
                            state.setDataStorage({ ...state.dataStorage, backupFrequency: v })
                            setHasChanges(true)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="hourly">Hourly</SelectItem>
                            <SelectItem value="daily">Daily</SelectItem>
                            <SelectItem value="weekly">Weekly</SelectItem>
                            <SelectItem value="monthly">Monthly</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="location">Backup Location</Label>
                        <Select 
                          value={state.dataStorage.backupLocation} 
                          onValueChange={(v) => {
                            state.setDataStorage({ ...state.dataStorage, backupLocation: v })
                            setHasChanges(true)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cloud">Cloud</SelectItem>
                            <SelectItem value="local">Local Storage</SelectItem>
                            <SelectItem value="both">Both</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="sync">Sync Enabled</Label>
                      <p className="text-sm text-muted-foreground">Sync data across devices</p>
                    </div>
                    <Switch
                      id="sync"
                      checked={state.dataStorage.syncEnabled}
                      onCheckedChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, syncEnabled: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Storage Management</CardTitle>
                  <CardDescription>Manage cache and storage settings</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="cache">Cache Size (MB): {state.dataStorage.cacheSize}</Label>
                    <Slider
                      id="cache"
                      value={[state.dataStorage.cacheSize]}
                      onValueChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, cacheSize: v[0] })
                        setHasChanges(true)
                      }}
                      min={50}
                      max={500}
                      step={50}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="offline">Offline Mode</Label>
                      <p className="text-sm text-muted-foreground">Enable offline access to data</p>
                    </div>
                    <Switch
                      id="offline"
                      checked={state.dataStorage.offlineMode}
                      onCheckedChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, offlineMode: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="retention">Data Retention (days): {state.dataStorage.retentionPeriod}</Label>
                    <Slider
                      id="retention"
                      value={[state.dataStorage.retentionPeriod]}
                      onValueChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, retentionPeriod: v[0] })
                        setHasChanges(true)
                      }}
                      min={7}
                      max={365}
                      step={7}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="autodelete">Auto Delete Old Data</Label>
                      <p className="text-sm text-muted-foreground">Automatically remove old data</p>
                    </div>
                    <Switch
                      id="autodelete"
                      checked={state.dataStorage.autoDelete}
                      onCheckedChange={(v) => {
                        state.setDataStorage({ ...state.dataStorage, autoDelete: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end gap-2">
                <Button variant="outline">Clear Cache</Button>
                <Button variant="outline">Export All Data</Button>
                <Button variant="outline" onClick={() => handleReset('Data & Storage')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Integrations Tab */}
            <TabsContent value="integrations" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Communication Platforms</CardTitle>
                  <CardDescription>Connect with messaging and collaboration tools</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="h-5 w-5" />
                        <div>
                          <p className="font-medium">Slack</p>
                          <p className="text-sm text-muted-foreground">Send notifications to Slack</p>
                        </div>
                      </div>
                      <Switch
                        checked={state.integrations.slack.enabled}
                        onCheckedChange={(v) => {
                          state.setIntegrations({
                            ...state.integrations,
                            slack: { ...state.integrations.slack, enabled: v }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </div>
                    {state.integrations.slack.enabled && (
                      <Input
                        placeholder="Webhook URL"
                        value={state.integrations.slack.webhook}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            slack: { ...state.integrations.slack, webhook: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                    )}
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Headphones className="h-5 w-5" />
                        <div>
                          <p className="font-medium">Discord</p>
                          <p className="text-sm text-muted-foreground">Connect with Discord</p>
                        </div>
                      </div>
                      <Switch
                        checked={state.integrations.discord.enabled}
                        onCheckedChange={(v) => {
                          state.setIntegrations({
                            ...state.integrations,
                            discord: { ...state.integrations.discord, enabled: v }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </div>
                    {state.integrations.discord.enabled && (
                      <Input
                        placeholder="Webhook URL"
                        value={state.integrations.discord.webhook}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            discord: { ...state.integrations.discord, webhook: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Development Tools</CardTitle>
                  <CardDescription>Connect with development and productivity tools</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5" />
                        <div>
                          <p className="font-medium">GitHub</p>
                          <p className="text-sm text-muted-foreground">Integrate with GitHub</p>
                        </div>
                      </div>
                      <Switch
                        checked={state.integrations.github.enabled}
                        onCheckedChange={(v) => {
                          state.setIntegrations({
                            ...state.integrations,
                            github: { ...state.integrations.github, enabled: v }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </div>
                    {state.integrations.github.enabled && (
                      <Input
                        placeholder="Personal Access Token"
                        type="password"
                        value={state.integrations.github.token}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            github: { ...state.integrations.github, token: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                    )}
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Zap className="h-5 w-5" />
                        <div>
                          <p className="font-medium">Zapier</p>
                          <p className="text-sm text-muted-foreground">Automate workflows</p>
                        </div>
                      </div>
                      <Switch
                        checked={state.integrations.zapier.enabled}
                        onCheckedChange={(v) => {
                          state.setIntegrations({
                            ...state.integrations,
                            zapier: { ...state.integrations.zapier, enabled: v }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </div>
                    {state.integrations.zapier.enabled && (
                      <Input
                        placeholder="API Key"
                        type="password"
                        value={state.integrations.zapier.apiKey}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            zapier: { ...state.integrations.zapier, apiKey: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Custom Webhook</CardTitle>
                  <CardDescription>Configure a custom webhook endpoint</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Webhook className="h-5 w-5" />
                      <div>
                        <p className="font-medium">Custom Webhook</p>
                        <p className="text-sm text-muted-foreground">Send data to custom endpoint</p>
                      </div>
                    </div>
                    <Switch
                      checked={state.integrations.webhook.enabled}
                      onCheckedChange={(v) => {
                        state.setIntegrations({
                          ...state.integrations,
                          webhook: { ...state.integrations.webhook, enabled: v }
                        })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                  {state.integrations.webhook.enabled && (
                    <>
                      <Input
                        placeholder="Webhook URL"
                        value={state.integrations.webhook.url}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            webhook: { ...state.integrations.webhook, url: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                      <Input
                        placeholder="Secret (optional)"
                        type="password"
                        value={state.integrations.webhook.secret}
                        onChange={(e) => {
                          state.setIntegrations({
                            ...state.integrations,
                            webhook: { ...state.integrations.webhook, secret: e.target.value }
                          })
                          setHasChanges(true)
                        }}
                      />
                    </>
                  )}
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => handleReset('Integrations')}>
                  Reset to Defaults
                </Button>
              </div>
            )}

            {/* Advanced Tab */}
            <TabsContent value="advanced" className="space-y-6 pb-6">
              <Card>
                <CardHeader>
                  <CardTitle>Developer Settings</CardTitle>
                  <CardDescription>Advanced settings for developers</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="devmode">Developer Mode</Label>
                      <p className="text-sm text-muted-foreground">Enable developer tools and features</p>
                    </div>
                    <Switch
                      id="devmode"
                      checked={state.advanced.developerMode}
                      onCheckedChange={(v) => {
                        state.setAdvanced({ ...state.advanced, developerMode: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="beta">Beta Features</Label>
                      <p className="text-sm text-muted-foreground">Try new features before release</p>
                    </div>
                    <Switch
                      id="beta"
                      checked={state.advanced.betaFeatures}
                      onCheckedChange={(v) => {
                        state.setAdvanced({ ...state.advanced, betaFeatures: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="experimental">Experimental Features</Label>
                      <p className="text-sm text-muted-foreground">⚠️ May be unstable</p>
                    </div>
                    <Switch
                      id="experimental"
                      checked={state.advanced.experimentalFeatures}
                      onCheckedChange={(v) => {
                        state.setAdvanced({ ...state.advanced, experimentalFeatures: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="debug">Debug Logging</Label>
                      <p className="text-sm text-muted-foreground">Enable verbose logging</p>
                    </div>
                    <Switch
                      id="debug"
                      checked={state.advanced.debugLogging}
                      onCheckedChange={(v) => {
                        state.setAdvanced({ ...state.advanced, debugLogging: v })
                        setHasChanges(true)
                      }}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Performance</CardTitle>
                  <CardDescription>Optimize application performance</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="performance">Performance Mode</Label>
                    <Select 
                      value={state.advanced.performanceMode} 
                      onValueChange={(v) => {
                        state.setAdvanced({ ...state.advanced, performanceMode: v })
                        setHasChanges(true)
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="powersaver">Power Saver</SelectItem>
                        <SelectItem value="balanced">Balanced</SelectItem>
                        <SelectItem value="performance">High Performance</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ratelimit">API Rate Limit (req/min): {state.advanced.apiRateLimit}</Label>
                    <Slider
                      id="ratelimit"
                      value={[state.advanced.apiRateLimit]}
                      onValueChange={(v) => {
                        state.setAdvanced({ ...state.advanced, apiRateLimit: v[0] })
                        setHasChanges(true)
                      }}
                      min={10}
                      max={1000}
                      step={10}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="upload">Max Upload Size (MB): {state.advanced.maxUploadSize}</Label>
                    <Slider
                      id="upload"
                      value={[state.advanced.maxUploadSize]}
                      onValueChange={(v) => {
                        state.setAdvanced({ ...state.advanced, maxUploadSize: v[0] })
                        setHasChanges(true)
                      }}
                      min={1}
                      max={100}
                      step={1}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeout">Connection Timeout (seconds): {state.advanced.connectionTimeout}</Label>
                    <Slider
                      id="timeout"
                      value={[state.advanced.connectionTimeout]}
                      onValueChange={(v) => {
                        state.setAdvanced({ ...state.advanced, connectionTimeout: v[0] })
                        setHasChanges(true)
                      }}
                      min={5}
                      max={60}
                      step={5}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Custom Code</CardTitle>
                  <CardDescription>Add custom CSS and JavaScript (Advanced users only)</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="css">Custom CSS</Label>
                    <Textarea
                      id="css"
                      placeholder="/* Your custom CSS here */"
                      value={state.advanced.customCSS}
                      onChange={(e) => {
                        state.setAdvanced({ ...state.advanced, customCSS: e.target.value })
                        setHasChanges(true)
                      }}
                      className="font-mono h-32"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="js">Custom JavaScript</Label>
                    <Textarea
                      id="js"
                      placeholder="// Your custom JavaScript here"
                      value={state.advanced.customJS}
                      onChange={(e) => {
                        state.setAdvanced({ ...state.advanced, customJS: e.target.value })
                        setHasChanges(true)
                      }}
                      className="font-mono h-32"
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end gap-2">
                <Button variant="outline">View Logs</Button>
                <Button variant="outline" onClick={() => handleReset('Advanced')}>
                  Reset to Defaults
                </Button>
              </div>
            )}
          </ScrollArea>

          {/* Footer with Save/Cancel buttons */}
          <div className="flex items-center justify-between px-6 py-4 border-t">
            <div className="flex items-center gap-2">
              {hasChanges && (
                <Badge variant="outline" className="gap-1">
                  <Info className="h-3 w-3" />
                  You have unsaved changes
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                onClick={() => onOpenChange?.(false)}
              >
                Cancel
              </Button>
              <Button 
                onClick={handleSave}
                disabled={!hasChanges}
              >
                <Save className="h-4 w-4 mr-2" />
                Save Changes
              </Button>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}