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
  Plus,
  Edit,
  MoreVertical,
  Copy,
  Filter,
  UserPlus,
  Building,
  DollarSign,
  History,
  GitBranch,
  Code,
  FileCode,
  Hash,
  ExternalLink,
  Crown,
  UserX,
  CheckCircle,
  XCircle,
  AlertTriangle,
  PauseCircle,
} from "lucide-react"

import { Dialog } from "./dialog"
import { DialogContentWide } from "./dialog-wide"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { Avatar, AvatarFallback, AvatarImage } from "./avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Progress } from "./progress"
import { cn } from "../lib/utils"
import { toast } from "sonner"

interface SettingsDialogFullProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

// Mock data for users
const mockUsers = [
  { id: 1, name: "John Doe", email: "john@example.com", role: "Admin", status: "active", lastActive: "2 min ago", avatar: "JD" },
  { id: 2, name: "Jane Smith", email: "jane@example.com", role: "Editor", status: "active", lastActive: "1 hour ago", avatar: "JS" },
  { id: 3, name: "Bob Johnson", email: "bob@example.com", role: "Viewer", status: "inactive", lastActive: "2 days ago", avatar: "BJ" },
  { id: 4, name: "Alice Brown", email: "alice@example.com", role: "Editor", status: "active", lastActive: "5 min ago", avatar: "AB" },
  { id: 5, name: "Charlie Wilson", email: "charlie@example.com", role: "Admin", status: "pending", lastActive: "Never", avatar: "CW" },
]

// Mock data for workspaces
const mockWorkspaces = [
  { id: 1, name: "Marketing Team", members: 12, plan: "Pro", storage: "45 GB", status: "active" },
  { id: 2, name: "Development", members: 25, plan: "Enterprise", storage: "120 GB", status: "active" },
  { id: 3, name: "Sales Department", members: 8, plan: "Pro", storage: "23 GB", status: "active" },
  { id: 4, name: "Design Studio", members: 6, plan: "Basic", storage: "15 GB", status: "trial" },
]

// Mock data for API keys
const mockApiKeys = [
  { id: 1, name: "Production API", key: "sk_live_...abc123", created: "2024-01-15", lastUsed: "Today", status: "active" },
  { id: 2, name: "Development API", key: "sk_test_...xyz789", created: "2024-02-01", lastUsed: "Yesterday", status: "active" },
  { id: 3, name: "Mobile App Key", key: "sk_mob_...def456", created: "2024-01-20", lastUsed: "3 days ago", status: "active" },
  { id: 4, name: "Legacy Integration", key: "sk_old_...ghi789", created: "2023-12-01", lastUsed: "1 month ago", status: "revoked" },
]

// Mock data for audit log
const mockAuditLog = [
  { id: 1, user: "John Doe", action: "Updated user permissions", target: "Jane Smith", time: "2 minutes ago", ip: "192.168.1.1" },
  { id: 2, user: "System", action: "Automated backup completed", target: "Database", time: "1 hour ago", ip: "System" },
  { id: 3, user: "Jane Smith", action: "Created new workspace", target: "Design Studio", time: "3 hours ago", ip: "192.168.1.2" },
  { id: 4, user: "Alice Brown", action: "Deleted API key", target: "Legacy Integration", time: "Yesterday", ip: "192.168.1.3" },
  { id: 5, user: "Bob Johnson", action: "Changed billing plan", target: "Pro to Enterprise", time: "2 days ago", ip: "192.168.1.4" },
]

const tabs = [
  { 
    id: "users", 
    label: "Users", 
    icon: Users, 
    category: "Management",
    description: "User accounts and permissions"
  },
  { 
    id: "workspaces", 
    label: "Workspaces", 
    icon: Building2, 
    category: "Management",
    description: "Teams and organizations"
  },
  { 
    id: "billing", 
    label: "Billing", 
    icon: CreditCard, 
    category: "Management",
    description: "Subscription and payments"
  },
  { 
    id: "appearance", 
    label: "Appearance", 
    icon: Palette, 
    category: "General",
    description: "Theme and display settings"
  },
  { 
    id: "notifications", 
    label: "Notifications", 
    icon: Bell, 
    category: "General",
    description: "Alerts and communications"
  },
  { 
    id: "security", 
    label: "Security", 
    icon: Shield, 
    category: "Security",
    description: "Authentication and access"
  },
  { 
    id: "api-keys", 
    label: "API Keys", 
    icon: Key, 
    category: "Security",
    description: "API access management"
  },
  { 
    id: "audit-log", 
    label: "Audit Log", 
    icon: History, 
    category: "Security",
    description: "Activity tracking"
  },
  { 
    id: "integrations", 
    label: "Integrations", 
    icon: Link, 
    category: "System",
    description: "Third-party connections"
  },
  { 
    id: "data", 
    label: "Data & Storage", 
    icon: Database, 
    category: "System",
    description: "Backup and storage"
  },
  { 
    id: "advanced", 
    label: "Advanced", 
    icon: Wrench, 
    category: "System",
    description: "Developer settings"
  },
]

// Settings state management
const useSettingsState = () => {
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

  const [theme, setTheme] = React.useState<"light" | "dark" | "system">(() => 
    loadSetting('theme', 'system')
  )
  
  const saveSetting = (key: string, value: any) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value))
    }
  }

  React.useEffect(() => { saveSetting('theme', theme) }, [theme])

  return {
    theme, setTheme,
  }
}

export function SettingsDialogFull({
  open = false,
  onOpenChange,
}: SettingsDialogFullProps) {
  const [activeTab, setActiveTab] = React.useState("users")
  const [searchQuery, setSearchQuery] = React.useState("")
  const [hasChanges, setHasChanges] = React.useState(false)
  const [selectedUsers, setSelectedUsers] = React.useState<number[]>([])
  const state = useSettingsState()

  const filteredTabs = tabs.filter(tab => 
    tab.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
    tab.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const groupedTabs = filteredTabs.reduce((acc, tab) => {
    if (!acc[tab.category]) {
      acc[tab.category] = []
    }
    acc[tab.category].push(tab)
    return acc
  }, {} as Record<string, typeof tabs>)

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
    setHasChanges(false)
    toast.success("Settings saved", {
      description: "Your changes have been saved successfully.",
    })
  }

  const activeTabData = tabs.find(t => t.id === activeTab)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContentWide className="w-[min(1800px,95vw)] h-[95vh] p-0 overflow-hidden">
        <div className="flex h-full">
          {/* Sidebar */}
          <div className="w-80 border-r bg-muted/10 flex flex-col">
            {/* Header */}
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold mb-4">Settings</h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Search settings..."
                  className="pl-10 h-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {/* Navigation */}
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-6">
                {Object.entries(groupedTabs).map(([category, items]) => (
                  <div key={category} className="space-y-1">
                    <div className="px-3 py-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        {category}
                      </p>
                    </div>
                    <div className="space-y-1">
                      {items.map((tab) => {
                        const Icon = tab.icon
                        return (
                          <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                              "w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-all duration-200 group",
                              activeTab === tab.id
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "hover:bg-muted/70 text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <Icon className={cn(
                              "h-5 w-5 mt-0.5 flex-shrink-0",
                              activeTab === tab.id ? "text-primary-foreground" : "text-muted-foreground group-hover:text-foreground"
                            )} />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm">{tab.label}</div>
                              <div className={cn(
                                "text-xs mt-0.5 line-clamp-1",
                                activeTab === tab.id ? "text-primary-foreground/80" : "text-muted-foreground"
                              )}>
                                {tab.description}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col">
            {/* Content Header */}
            <div className="px-8 py-6 border-b bg-background/95">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {activeTabData && <activeTabData.icon className="h-6 w-6 text-muted-foreground" />}
                  <div>
                    <h3 className="text-xl font-semibold">{activeTabData?.label}</h3>
                    <p className="text-sm text-muted-foreground">{activeTabData?.description}</p>
                  </div>
                </div>
                {activeTab === "users" && (
                  <Button className="gap-2">
                    <UserPlus className="h-4 w-4" />
                    Add User
                  </Button>
                )}
                {activeTab === "workspaces" && (
                  <Button className="gap-2">
                    <Plus className="h-4 w-4" />
                    New Workspace
                  </Button>
                )}
                {activeTab === "api-keys" && (
                  <Button className="gap-2">
                    <Plus className="h-4 w-4" />
                    Generate Key
                  </Button>
                )}
              </div>
            </div>

            {/* Content Body */}
            <ScrollArea className="flex-1">
              <div className="p-8">
                {/* Users Tab */}
                {activeTab === "users" && (
                  <div className="space-y-6">
                    {/* Filters and Actions */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                          <Input
                            placeholder="Search users..."
                            className="pl-10 w-80"
                          />
                        </div>
                        <Select defaultValue="all">
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Roles</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select defaultValue="active">
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="inactive">Inactive</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="all">All Status</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedUsers.length > 0 && (
                          <>
                            <Badge variant="secondary">{selectedUsers.length} selected</Badge>
                            <Button variant="outline" size="sm">
                              <Mail className="h-4 w-4 mr-2" />
                              Email
                            </Button>
                            <Button variant="outline" size="sm">
                              <UserX className="h-4 w-4 mr-2" />
                              Remove
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Users Table */}
                    <Card>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">
                              <input 
                                type="checkbox"
                                className="rounded"
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedUsers(mockUsers.map(u => u.id))
                                  } else {
                                    setSelectedUsers([])
                                  }
                                }}
                              />
                            </TableHead>
                            <TableHead>User</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Last Active</TableHead>
                            <TableHead className="w-12"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {mockUsers.map((user) => (
                            <TableRow key={user.id}>
                              <TableCell>
                                <input 
                                  type="checkbox"
                                  className="rounded"
                                  checked={selectedUsers.includes(user.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedUsers([...selectedUsers, user.id])
                                    } else {
                                      setSelectedUsers(selectedUsers.filter(id => id !== user.id))
                                    }
                                  }}
                                />
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  <Avatar className="h-8 w-8">
                                    <AvatarFallback>{user.avatar}</AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <div className="font-medium">{user.name}</div>
                                    <div className="text-sm text-muted-foreground">{user.email}</div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant={user.role === "Admin" ? "default" : "secondary"}>
                                  {user.role === "Admin" && <Crown className="h-3 w-3 mr-1" />}
                                  {user.role}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Badge 
                                  variant={
                                    user.status === "active" ? "success" : 
                                    user.status === "inactive" ? "secondary" : 
                                    "warning"
                                  }
                                  className="gap-1"
                                >
                                  {user.status === "active" && <CheckCircle className="h-3 w-3" />}
                                  {user.status === "inactive" && <XCircle className="h-3 w-3" />}
                                  {user.status === "pending" && <Clock className="h-3 w-3" />}
                                  {user.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {user.lastActive}
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon">
                                      <MoreVertical className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem>
                                      <Edit className="h-4 w-4 mr-2" />
                                      Edit User
                                    </DropdownMenuItem>
                                    <DropdownMenuItem>
                                      <Mail className="h-4 w-4 mr-2" />
                                      Send Email
                                    </DropdownMenuItem>
                                    <DropdownMenuItem>
                                      <Key className="h-4 w-4 mr-2" />
                                      Reset Password
                                    </DropdownMenuItem>
                                    <DropdownMenuItem>
                                      <Shield className="h-4 w-4 mr-2" />
                                      Change Role
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive">
                                      <UserX className="h-4 w-4 mr-2" />
                                      Remove User
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>

                    {/* User Statistics */}
                    <div className="grid grid-cols-4 gap-4">
                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">Total Users</p>
                              <p className="text-2xl font-bold">1,234</p>
                              <p className="text-xs text-green-600">+12% from last month</p>
                            </div>
                            <Users className="h-8 w-8 text-muted-foreground" />
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">Active Today</p>
                              <p className="text-2xl font-bold">892</p>
                              <p className="text-xs text-green-600">72% of total</p>
                            </div>
                            <Activity className="h-8 w-8 text-muted-foreground" />
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">New This Week</p>
                              <p className="text-2xl font-bold">48</p>
                              <p className="text-xs text-blue-600">Pending approval: 5</p>
                            </div>
                            <UserPlus className="h-8 w-8 text-muted-foreground" />
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-6">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm text-muted-foreground">Admin Users</p>
                              <p className="text-2xl font-bold">12</p>
                              <p className="text-xs text-muted-foreground">0.97% of total</p>
                            </div>
                            <Crown className="h-8 w-8 text-muted-foreground" />
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}

                {/* Workspaces Tab */}
                {activeTab === "workspaces" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-3 gap-6">
                      {mockWorkspaces.map((workspace) => (
                        <Card key={workspace.id}>
                          <CardHeader>
                            <div className="flex items-center justify-between">
                              <CardTitle>{workspace.name}</CardTitle>
                              <Badge variant={workspace.status === "trial" ? "warning" : "default"}>
                                {workspace.plan}
                              </Badge>
                            </div>
                            <CardDescription>
                              {workspace.members} members • {workspace.storage} used
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-4">
                            <div className="space-y-2">
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Storage Usage</span>
                                <span>{workspace.storage}</span>
                              </div>
                              <Progress value={parseInt(workspace.storage)} className="h-2" />
                            </div>
                            <div className="flex gap-2">
                              <Button variant="outline" size="sm" className="flex-1">
                                <Settings className="h-4 w-4 mr-2" />
                                Manage
                              </Button>
                              <Button variant="outline" size="sm" className="flex-1">
                                <Users className="h-4 w-4 mr-2" />
                                Members
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {/* API Keys Tab */}
                {activeTab === "api-keys" && (
                  <div className="space-y-6">
                    <Card>
                      <CardHeader>
                        <CardTitle>API Keys</CardTitle>
                        <CardDescription>Manage your API keys for programmatic access</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Key</TableHead>
                              <TableHead>Created</TableHead>
                              <TableHead>Last Used</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {mockApiKeys.map((apiKey) => (
                              <TableRow key={apiKey.id}>
                                <TableCell className="font-medium">{apiKey.name}</TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <code className="text-xs bg-muted px-2 py-1 rounded">
                                      {apiKey.key}
                                    </code>
                                    <Button variant="ghost" size="icon" className="h-6 w-6">
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </TableCell>
                                <TableCell>{apiKey.created}</TableCell>
                                <TableCell>{apiKey.lastUsed}</TableCell>
                                <TableCell>
                                  <Badge variant={apiKey.status === "active" ? "success" : "secondary"}>
                                    {apiKey.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon">
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem>
                                        <Edit className="h-4 w-4 mr-2" />
                                        Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuItem>
                                        <RefreshCw className="h-4 w-4 mr-2" />
                                        Regenerate
                                      </DropdownMenuItem>
                                      <DropdownMenuItem className="text-destructive">
                                        <Trash className="h-4 w-4 mr-2" />
                                        Revoke
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Billing Tab */}
                {activeTab === "billing" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                      <Card>
                        <CardHeader>
                          <CardTitle>Current Plan</CardTitle>
                          <CardDescription>You're currently on the Pro plan</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center justify-between p-4 border rounded-lg">
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="font-semibold">Pro Plan</h4>
                                <Badge>Current</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                $29/month • Billed monthly
                              </p>
                            </div>
                            <Button variant="outline">Change Plan</Button>
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between text-sm">
                              <span>Next billing date</span>
                              <span className="font-medium">January 15, 2025</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span>Payment method</span>
                              <span className="font-medium">•••• 4242</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>Usage This Month</CardTitle>
                          <CardDescription>Your usage for the current billing period</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="space-y-3">
                            <div>
                              <div className="flex justify-between text-sm mb-1">
                                <span>API Calls</span>
                                <span>75,000 / 100,000</span>
                              </div>
                              <Progress value={75} />
                            </div>
                            <div>
                              <div className="flex justify-between text-sm mb-1">
                                <span>Storage</span>
                                <span>45 GB / 100 GB</span>
                              </div>
                              <Progress value={45} />
                            </div>
                            <div>
                              <div className="flex justify-between text-sm mb-1">
                                <span>Team Members</span>
                                <span>8 / 10</span>
                              </div>
                              <Progress value={80} />
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    <Card>
                      <CardHeader>
                        <CardTitle>Payment History</CardTitle>
                        <CardDescription>Your recent transactions</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Date</TableHead>
                              <TableHead>Description</TableHead>
                              <TableHead>Amount</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <TableRow>
                              <TableCell>Dec 15, 2024</TableCell>
                              <TableCell>Pro Plan - Monthly</TableCell>
                              <TableCell>$29.00</TableCell>
                              <TableCell>
                                <Badge variant="success">Paid</Badge>
                              </TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm">
                                  <Download className="h-4 w-4 mr-2" />
                                  Invoice
                                </Button>
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell>Nov 15, 2024</TableCell>
                              <TableCell>Pro Plan - Monthly</TableCell>
                              <TableCell>$29.00</TableCell>
                              <TableCell>
                                <Badge variant="success">Paid</Badge>
                              </TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm">
                                  <Download className="h-4 w-4 mr-2" />
                                  Invoice
                                </Button>
                              </TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Audit Log Tab */}
                {activeTab === "audit-log" && (
                  <div className="space-y-6">
                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <div>
                            <CardTitle>Activity Log</CardTitle>
                            <CardDescription>Track all actions and changes in your account</CardDescription>
                          </div>
                          <div className="flex items-center gap-2">
                            <Select defaultValue="all">
                              <SelectTrigger className="w-40">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="all">All Activities</SelectItem>
                                <SelectItem value="users">User Actions</SelectItem>
                                <SelectItem value="security">Security Events</SelectItem>
                                <SelectItem value="billing">Billing Changes</SelectItem>
                                <SelectItem value="data">Data Operations</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button variant="outline" size="icon">
                              <Filter className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-4">
                          {mockAuditLog.map((log) => (
                            <div key={log.id} className="flex items-start gap-4 p-4 border rounded-lg">
                              <div className="p-2 bg-muted rounded-full">
                                <History className="h-4 w-4" />
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{log.user}</span>
                                  <span className="text-muted-foreground">{log.action}</span>
                                  {log.target && (
                                    <>
                                      <span className="text-muted-foreground">•</span>
                                      <span className="font-medium">{log.target}</span>
                                    </>
                                  )}
                                </div>
                                <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                                  <span>{log.time}</span>
                                  <span>IP: {log.ip}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Security Tab */}
                {activeTab === "security" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                      <Card>
                        <CardHeader>
                          <CardTitle>Security Settings</CardTitle>
                          <CardDescription>Configure security preferences</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label htmlFor="2fa">Two-Factor Authentication</Label>
                              <p className="text-sm text-muted-foreground">Add an extra layer of security</p>
                            </div>
                            <Switch id="2fa" />
                          </div>
                          <Separator />
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label htmlFor="session">Session Timeout</Label>
                              <p className="text-sm text-muted-foreground">Auto logout after inactivity</p>
                            </div>
                            <Select defaultValue="30">
                              <SelectTrigger className="w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="15">15 minutes</SelectItem>
                                <SelectItem value="30">30 minutes</SelectItem>
                                <SelectItem value="60">1 hour</SelectItem>
                                <SelectItem value="never">Never</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <Separator />
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label htmlFor="alerts">Login Alerts</Label>
                              <p className="text-sm text-muted-foreground">Get notified of new sign-ins</p>
                            </div>
                            <Switch id="alerts" defaultChecked />
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle>Recent Security Events</CardTitle>
                          <CardDescription>Monitor account access</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <CheckCircle className="h-4 w-4 text-green-600" />
                                <span>Successful login from Chrome</span>
                              </div>
                              <span className="text-muted-foreground">2 min ago</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                                <span>Password changed</span>
                              </div>
                              <span className="text-muted-foreground">3 days ago</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <CheckCircle className="h-4 w-4 text-green-600" />
                                <span>2FA enabled</span>
                              </div>
                              <span className="text-muted-foreground">1 week ago</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}

                {/* Integrations Tab */}
                {activeTab === "integrations" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-3 gap-6">
                      <Card>
                        <CardHeader>
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-[#6366F1] rounded">
                              <MessageSquare className="h-6 w-6 text-white" />
                            </div>
                            <div>
                              <CardTitle>Slack</CardTitle>
                              <CardDescription>Team communication</CardDescription>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-4">
                            <Badge variant="success">Connected</Badge>
                            <Button variant="outline" className="w-full">Configure</Button>
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-black rounded">
                              <GitBranch className="h-6 w-6 text-white" />
                            </div>
                            <div>
                              <CardTitle>GitHub</CardTitle>
                              <CardDescription>Code repository</CardDescription>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-4">
                            <Badge variant="secondary">Not Connected</Badge>
                            <Button className="w-full">Connect</Button>
                          </div>
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-[#FF5E5B] rounded">
                              <Zap className="h-6 w-6 text-white" />
                            </div>
                            <div>
                              <CardTitle>Zapier</CardTitle>
                              <CardDescription>Automation</CardDescription>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-4">
                            <Badge variant="success">Connected</Badge>
                            <Button variant="outline" className="w-full">Configure</Button>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="px-8 py-4 border-t bg-background/95 backdrop-blur">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {hasChanges && (
                    <Badge variant="outline" className="gap-1">
                      <Info className="h-3 w-3" />
                      You have unsaved changes
                    </Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onOpenChange?.(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={!hasChanges}>
                    <Save className="h-4 w-4 mr-2" />
                    Save Changes
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContentWide>
    </Dialog>
  )
}