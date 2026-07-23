"use client"

import * as React from "react"
import {
  Bell,
  Check,
  Globe,
  Home,
  Keyboard,
  Link,
  Lock,
  Menu,
  MessageCircle,
  Paintbrush,
  Settings,
  Video,
  Users,
  Building2,
  CreditCard,
  Shield,
  Key,
  Database,
  History,
  Wrench,
  Moon,
  Sun,
  Monitor,
  Mail,
  Smartphone,
  Eye,
  Volume2,
  UserPlus,
  Plus,
  Search,
  Filter,
  MoreVertical,
  Edit,
  Trash,
  Copy,
  RefreshCw,
  Download,
  ChevronRight,
  Crown,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  GitBranch,
  Zap,
  Save,
  X,
  UserX,
  Activity,
  DollarSign,
  Loader2,
} from "lucide-react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb"
import { Button } from "./button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DialogHeader,
  DialogFooter,
} from "./dialog"
import { DialogContentWide } from "./dialog-wide"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from "./sidebar"
import { Switch } from "./switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { Slider } from "./slider"
import { Label } from "./label"
import { Input } from "./input"
import { Textarea } from "./textarea"
import { Badge } from "./badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Separator } from "./separator"
import { RadioGroup, RadioGroupItem } from "./radio-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { Avatar, AvatarFallback, AvatarImage } from "./avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Progress } from "./progress"
import { Checkbox } from "./checkbox"
import { ScrollArea } from "./scroll-area"
import { cn } from "../lib/utils"
import { toast } from "sonner"

// Type definitions for server actions
interface User {
  id: string
  email: string
  name?: string | null
  role: "USER" | "ADMIN" | "MERCHANT"
  createdAt: Date
  workspaces?: Array<{
    id: string
    name: string
    slug: string
  }>
}

interface Workspace {
  id: string
  name: string
  slug: string
  description?: string | null
  createdAt: Date
  workspaceMembers?: Array<{
    user: User
    role: string
  }>
  _count?: {
    workspaceMembers: number
  }
}

interface ApiKey {
  id: string
  name: string
  key: string
  permissions: string[]
  createdAt: Date
  lastUsed?: Date
  expiresAt?: Date
}

interface AuditLog {
  id: string
  userId: string
  userName: string
  action: string
  details: string
  ipAddress: string
  timestamp: Date
  status: string
}

interface SettingsModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: React.ReactNode
  // Server actions
  serverActions?: {
    getUsers: () => Promise<{ success: boolean; data?: User[]; error?: string }>
    createUser: (data: any) => Promise<{ success: boolean; data?: User; error?: string }>
    updateUser: (userId: string, data: any) => Promise<{ success: boolean; data?: User; error?: string }>
    deleteUser: (userId: string) => Promise<{ success: boolean; error?: string }>
    getWorkspaces: () => Promise<{ success: boolean; data?: Workspace[]; error?: string }>
    createWorkspace: (data: any) => Promise<{ success: boolean; data?: Workspace; error?: string }>
    updateWorkspace: (id: string, data: any) => Promise<{ success: boolean; data?: Workspace; error?: string }>
    deleteWorkspace: (id: string) => Promise<{ success: boolean; error?: string }>
    getApiKeys: () => Promise<{ success: boolean; data?: ApiKey[]; error?: string }>
    createApiKey: (data: any) => Promise<{ success: boolean; data?: ApiKey; error?: string }>
    revokeApiKey: (id: string) => Promise<{ success: boolean; error?: string }>
    getAuditLogs: (filters?: any) => Promise<{ success: boolean; data?: AuditLog[]; error?: string }>
    updateGeneralSettings: (settings: any) => Promise<{ success: boolean; data?: any; error?: string }>
    updateNotificationSettings: (settings: any) => Promise<{ success: boolean; data?: any; error?: string }>
    updateSecuritySettings: (settings: any) => Promise<{ success: boolean; data?: any; error?: string }>
  }
}

const navigationData = {
  general: [
    { name: "Appearance", icon: Paintbrush, id: "appearance" },
    { name: "Notifications", icon: Bell, id: "notifications" },
    { name: "Keyboard Shortcuts", icon: Keyboard, id: "shortcuts" },
  ],
  management: [
    { name: "Users", icon: Users, id: "users" },
    { name: "Workspaces", icon: Building2, id: "workspaces" },
    { name: "API Keys", icon: Key, id: "api-keys" },
  ],
  security: [
    { name: "Security", icon: Shield, id: "security" },
    { name: "Audit Log", icon: History, id: "audit" },
  ],
  system: [
    { name: "Database", icon: Database, id: "database" },
    { name: "Billing", icon: CreditCard, id: "billing" },
    { name: "Advanced", icon: Wrench, id: "advanced" },
  ],
}

export function SettingsModalEnhanced({ 
  open, 
  onOpenChange, 
  trigger,
  serverActions 
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = React.useState("appearance")
  const [loading, setLoading] = React.useState(false)
  
  // Data states
  const [users, setUsers] = React.useState<User[]>([])
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [apiKeys, setApiKeys] = React.useState<ApiKey[]>([])
  const [auditLogs, setAuditLogs] = React.useState<AuditLog[]>([])
  
  // UI states
  const [selectedUsers, setSelectedUsers] = React.useState<string[]>([])
  const [userSearchQuery, setUserSearchQuery] = React.useState("")
  const [userRoleFilter, setUserRoleFilter] = React.useState("all")
  const [showAddUserDialog, setShowAddUserDialog] = React.useState(false)
  const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] = React.useState(false)
  const [showAddApiKeyDialog, setShowAddApiKeyDialog] = React.useState(false)
  
  // Settings states
  const [theme, setTheme] = React.useState<"light" | "dark" | "system">("system")
  const [fontSize, setFontSize] = React.useState([16])
  const [emailNotifications, setEmailNotifications] = React.useState(true)
  const [pushNotifications, setPushNotifications] = React.useState(false)
  const [smsNotifications, setSmsNotifications] = React.useState(false)
  const [marketingEmails, setMarketingEmails] = React.useState(true)
  const [twoFactorEnabled, setTwoFactorEnabled] = React.useState(false)
  const [sessionTimeout, setSessionTimeout] = React.useState([30])
  
  // Form states for dialogs
  const [newUserData, setNewUserData] = React.useState({
    name: "",
    email: "",
    password: "",
    role: "USER" as "USER" | "ADMIN" | "MERCHANT"
  })
  
  const [newWorkspaceData, setNewWorkspaceData] = React.useState({
    name: "",
    description: ""
  })
  
  const [newApiKeyData, setNewApiKeyData] = React.useState({
    name: "",
    permissions: [] as string[]
  })

  // Load data when modal opens or section changes
  React.useEffect(() => {
    if (open && serverActions) {
      loadDataForSection(activeSection)
    }
  }, [open, activeSection, serverActions])

  const loadDataForSection = async (section: string) => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      switch (section) {
        case "users":
          const usersResult = await serverActions.getUsers()
          if (usersResult.success && usersResult.data) {
            setUsers(usersResult.data)
          }
          break
        case "workspaces":
          const workspacesResult = await serverActions.getWorkspaces()
          if (workspacesResult.success && workspacesResult.data) {
            setWorkspaces(workspacesResult.data)
          }
          break
        case "api-keys":
          const keysResult = await serverActions.getApiKeys()
          if (keysResult.success && keysResult.data) {
            setApiKeys(keysResult.data)
          }
          break
        case "audit":
          const logsResult = await serverActions.getAuditLogs()
          if (logsResult.success && logsResult.data) {
            setAuditLogs(logsResult.data)
          }
          break
      }
    } catch (error) {
      console.error("Failed to load data:", error)
      toast.error("Failed to load data")
    } finally {
      setLoading(false)
    }
  }

  const handleCreateUser = async () => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      const result = await serverActions.createUser(newUserData)
      if (result.success) {
        toast.success("User created successfully")
        setShowAddUserDialog(false)
        setNewUserData({ name: "", email: "", password: "", role: "USER" })
        // Reload users
        const usersResult = await serverActions.getUsers()
        if (usersResult.success && usersResult.data) {
          setUsers(usersResult.data)
        }
      } else {
        toast.error(result.error || "Failed to create user")
      }
    } catch (error) {
      toast.error("Failed to create user")
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteUser = async (userId: string) => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      const result = await serverActions.deleteUser(userId)
      if (result.success) {
        toast.success("User deleted successfully")
        setUsers(users.filter(u => u.id !== userId))
      } else {
        toast.error(result.error || "Failed to delete user")
      }
    } catch (error) {
      toast.error("Failed to delete user")
    } finally {
      setLoading(false)
    }
  }

  const handleCreateWorkspace = async () => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      const result = await serverActions.createWorkspace(newWorkspaceData)
      if (result.success) {
        toast.success("Workspace created successfully")
        setShowAddWorkspaceDialog(false)
        setNewWorkspaceData({ name: "", description: "" })
        // Reload workspaces
        const workspacesResult = await serverActions.getWorkspaces()
        if (workspacesResult.success && workspacesResult.data) {
          setWorkspaces(workspacesResult.data)
        }
      } else {
        toast.error(result.error || "Failed to create workspace")
      }
    } catch (error) {
      toast.error("Failed to create workspace")
    } finally {
      setLoading(false)
    }
  }

  const handleCreateApiKey = async () => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      const result = await serverActions.createApiKey(newApiKeyData)
      if (result.success && result.data) {
        toast.success("API key created successfully")
        // Copy key to clipboard
        navigator.clipboard.writeText(result.data.key)
        toast.info("API key copied to clipboard")
        setShowAddApiKeyDialog(false)
        setNewApiKeyData({ name: "", permissions: [] })
        // Reload API keys
        const keysResult = await serverActions.getApiKeys()
        if (keysResult.success && keysResult.data) {
          setApiKeys(keysResult.data)
        }
      } else {
        toast.error(result.error || "Failed to create API key")
      }
    } catch (error) {
      toast.error("Failed to create API key")
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!serverActions) return
    
    setLoading(true)
    try {
      // Save settings based on active section
      switch (activeSection) {
        case "appearance":
          await serverActions.updateGeneralSettings({ theme, fontSize: fontSize[0] })
          break
        case "notifications":
          await serverActions.updateNotificationSettings({
            emailNotifications,
            pushNotifications,
            smsNotifications,
            marketingEmails
          })
          break
        case "security":
          await serverActions.updateSecuritySettings({
            twoFactorEnabled,
            sessionTimeout: sessionTimeout[0]
          })
          break
      }
      
      toast.success("Settings saved successfully")
      onOpenChange?.(false)
    } catch (error) {
      toast.error("Failed to save settings")
    } finally {
      setLoading(false)
    }
  }

  // Filter users based on search and role
  const filteredUsers = users.filter(user => {
    const matchesSearch = !userSearchQuery || 
      user.name?.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(userSearchQuery.toLowerCase())
    
    const matchesRole = userRoleFilter === "all" || 
      user.role.toLowerCase() === userRoleFilter.toLowerCase()
    
    return matchesSearch && matchesRole
  })

  // Get active section data
  const activeSectionData = Object.values(navigationData)
    .flat()
    .find(item => item.id === activeSection)

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      )
    }

    switch (activeSection) {
      case "appearance":
        return (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Theme</CardTitle>
                <CardDescription>Select your preferred theme for the application</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <RadioGroup value={theme} onValueChange={(v: any) => setTheme(v)}>
                  <div className="grid grid-cols-3 gap-4">
                    <label className={cn(
                      "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                      theme === "light" && "border-primary bg-accent"
                    )}>
                      <RadioGroupItem value="light" className="sr-only" />
                      <Sun className="h-8 w-8 mb-2" />
                      <span className="font-medium">Light</span>
                    </label>
                    <label className={cn(
                      "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                      theme === "dark" && "border-primary bg-accent"
                    )}>
                      <RadioGroupItem value="dark" className="sr-only" />
                      <Moon className="h-8 w-8 mb-2" />
                      <span className="font-medium">Dark</span>
                    </label>
                    <label className={cn(
                      "flex flex-col items-center justify-center rounded-lg border-2 p-4 cursor-pointer hover:bg-accent",
                      theme === "system" && "border-primary bg-accent"
                    )}>
                      <RadioGroupItem value="system" className="sr-only" />
                      <Monitor className="h-8 w-8 mb-2" />
                      <span className="font-medium">System</span>
                    </label>
                  </div>
                </RadioGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Font Size</CardTitle>
                <CardDescription>Adjust the font size for better readability</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Size</Label>
                    <span className="text-sm text-muted-foreground">{fontSize[0]}px</span>
                  </div>
                  <Slider
                    value={fontSize}
                    onValueChange={setFontSize}
                    min={12}
                    max={20}
                    step={1}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )
      
      case "notifications":
        return (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Email Notifications</CardTitle>
                <CardDescription>Manage your email notification preferences</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Email Notifications</Label>
                    <p className="text-sm text-muted-foreground">Receive notifications via email</p>
                  </div>
                  <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Marketing Emails</Label>
                    <p className="text-sm text-muted-foreground">Receive marketing and promotional emails</p>
                  </div>
                  <Switch checked={marketingEmails} onCheckedChange={setMarketingEmails} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Push Notifications</CardTitle>
                <CardDescription>Manage push notification settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Push Notifications</Label>
                    <p className="text-sm text-muted-foreground">Receive push notifications on your devices</p>
                  </div>
                  <Switch checked={pushNotifications} onCheckedChange={setPushNotifications} />
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>SMS Notifications</Label>
                    <p className="text-sm text-muted-foreground">Receive important alerts via SMS</p>
                  </div>
                  <Switch checked={smsNotifications} onCheckedChange={setSmsNotifications} />
                </div>
              </CardContent>
            </Card>
          </div>
        )
      
      case "users":
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input 
                    placeholder="Search users..." 
                    className="pl-10 w-80"
                    value={userSearchQuery}
                    onChange={(e) => setUserSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={userRoleFilter} onValueChange={setUserRoleFilter}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="merchant">Merchant</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={() => setShowAddUserDialog(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Add User
              </Button>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox />
                    </TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Workspaces</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedUsers.includes(user.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
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
                            <AvatarFallback>
                              {user.name ? user.name.slice(0, 2).toUpperCase() : user.email.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-medium">{user.name || "Unknown"}</div>
                            <div className="text-sm text-muted-foreground">{user.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === "ADMIN" ? "default" : "secondary"}>
                          {user.role === "ADMIN" && <Crown className="h-3 w-3 mr-1" />}
                          {user.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {user.workspaces?.length || 0} workspaces
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(user.createdAt).toLocaleDateString()}
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
                              <Mail className="h-4 w-4 mr-2" />
                              Email
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={() => handleDeleteUser(user.id)}
                            >
                              <Trash className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {/* Add User Dialog */}
            <Dialog open={showAddUserDialog} onOpenChange={setShowAddUserDialog}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add New User</DialogTitle>
                  <DialogDescription>Create a new user account</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={newUserData.name}
                      onChange={(e) => setNewUserData({ ...newUserData, name: e.target.value })}
                      placeholder="John Doe"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={newUserData.email}
                      onChange={(e) => setNewUserData({ ...newUserData, email: e.target.value })}
                      placeholder="john@example.com"
                    />
                  </div>
                  <div>
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={newUserData.password}
                      onChange={(e) => setNewUserData({ ...newUserData, password: e.target.value })}
                      placeholder="••••••••"
                    />
                  </div>
                  <div>
                    <Label htmlFor="role">Role</Label>
                    <Select 
                      value={newUserData.role} 
                      onValueChange={(value: "USER" | "ADMIN" | "MERCHANT") => 
                        setNewUserData({ ...newUserData, role: value })
                      }
                    >
                      <SelectTrigger id="role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USER">User</SelectItem>
                        <SelectItem value="ADMIN">Admin</SelectItem>
                        <SelectItem value="MERCHANT">Merchant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowAddUserDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateUser} disabled={loading}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create User
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )
      
      case "workspaces":
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Workspaces</h3>
              <Button onClick={() => setShowAddWorkspaceDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Workspace
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {workspaces.map((workspace) => (
                <Card key={workspace.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{workspace.name}</CardTitle>
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
                            <Users className="h-4 w-4 mr-2" />
                            Manage Members
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive">
                            <Trash className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {workspace.description && (
                      <CardDescription>{workspace.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Members</span>
                        <span className="font-medium">{workspace._count?.workspaceMembers || 0}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Created</span>
                        <span className="font-medium">
                          {new Date(workspace.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Add Workspace Dialog */}
            <Dialog open={showAddWorkspaceDialog} onOpenChange={setShowAddWorkspaceDialog}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Workspace</DialogTitle>
                  <DialogDescription>Create a new workspace for your team</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="workspace-name">Name</Label>
                    <Input
                      id="workspace-name"
                      value={newWorkspaceData.name}
                      onChange={(e) => setNewWorkspaceData({ ...newWorkspaceData, name: e.target.value })}
                      placeholder="Marketing Team"
                    />
                  </div>
                  <div>
                    <Label htmlFor="workspace-description">Description</Label>
                    <Textarea
                      id="workspace-description"
                      value={newWorkspaceData.description}
                      onChange={(e) => setNewWorkspaceData({ ...newWorkspaceData, description: e.target.value })}
                      placeholder="Workspace for the marketing team..."
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowAddWorkspaceDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateWorkspace} disabled={loading}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create Workspace
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )
      
      case "api-keys":
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">API Keys</h3>
              <Button onClick={() => setShowAddApiKeyDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Generate New Key
              </Button>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Permissions</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((apiKey) => (
                    <TableRow key={apiKey.id}>
                      <TableCell className="font-medium">{apiKey.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-muted px-2 py-1 rounded">
                            {apiKey.key.slice(0, 10)}...{apiKey.key.slice(-4)}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              navigator.clipboard.writeText(apiKey.key)
                              toast.success("API key copied to clipboard")
                            }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {apiKey.permissions.map((perm) => (
                            <Badge key={perm} variant="secondary" className="text-xs">
                              {perm}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(apiKey.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {apiKey.lastUsed ? new Date(apiKey.lastUsed).toLocaleDateString() : "Never"}
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
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Regenerate
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                              <Edit className="h-4 w-4 mr-2" />
                              Edit Permissions
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={async () => {
                                if (serverActions) {
                                  const result = await serverActions.revokeApiKey(apiKey.id)
                                  if (result.success) {
                                    toast.success("API key revoked")
                                    setApiKeys(apiKeys.filter(k => k.id !== apiKey.id))
                                  }
                                }
                              }}
                            >
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
            </Card>

            {/* Add API Key Dialog */}
            <Dialog open={showAddApiKeyDialog} onOpenChange={setShowAddApiKeyDialog}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Generate API Key</DialogTitle>
                  <DialogDescription>Create a new API key for your application</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="key-name">Key Name</Label>
                    <Input
                      id="key-name"
                      value={newApiKeyData.name}
                      onChange={(e) => setNewApiKeyData({ ...newApiKeyData, name: e.target.value })}
                      placeholder="Production API Key"
                    />
                  </div>
                  <div>
                    <Label>Permissions</Label>
                    <div className="space-y-2 mt-2">
                      {["read", "write", "delete", "admin"].map((permission) => (
                        <div key={permission} className="flex items-center space-x-2">
                          <Checkbox
                            id={permission}
                            checked={newApiKeyData.permissions.includes(permission)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setNewApiKeyData({
                                  ...newApiKeyData,
                                  permissions: [...newApiKeyData.permissions, permission]
                                })
                              } else {
                                setNewApiKeyData({
                                  ...newApiKeyData,
                                  permissions: newApiKeyData.permissions.filter(p => p !== permission)
                                })
                              }
                            }}
                          />
                          <Label htmlFor={permission} className="capitalize">
                            {permission}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowAddApiKeyDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateApiKey} disabled={loading}>
                    {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Generate Key
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )
      
      case "security":
        return (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Two-Factor Authentication</CardTitle>
                <CardDescription>Add an extra layer of security to your account</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Enable 2FA</Label>
                    <p className="text-sm text-muted-foreground">
                      Require authentication code on sign in
                    </p>
                  </div>
                  <Switch checked={twoFactorEnabled} onCheckedChange={setTwoFactorEnabled} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Session Management</CardTitle>
                <CardDescription>Control your active sessions and security settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Session Timeout</Label>
                    <span className="text-sm text-muted-foreground">{sessionTimeout[0]} minutes</span>
                  </div>
                  <Slider
                    value={sessionTimeout}
                    onValueChange={setSessionTimeout}
                    min={5}
                    max={120}
                    step={5}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )
      
      case "audit":
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Activity Log</h3>
              <Button variant="outline">
                <Download className="h-4 w-4 mr-2" />
                Export Logs
              </Button>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead>IP Address</TableHead>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">{log.userName}</TableCell>
                      <TableCell>
                        <code className="text-xs bg-muted px-2 py-1 rounded">
                          {log.action}
                        </code>
                      </TableCell>
                      <TableCell className="text-sm">{log.details}</TableCell>
                      <TableCell className="text-muted-foreground">{log.ipAddress}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(log.timestamp).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant={log.status === "success" ? "default" : "destructive"}
                          className="text-xs"
                        >
                          {log.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        )
      
      default:
        return (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>Select a section from the sidebar</p>
          </div>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && (
        <DialogTrigger asChild>
          {trigger}
        </DialogTrigger>
      )}
      <DialogContentWide className="flex flex-col overflow-hidden p-0">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application settings and preferences
        </DialogDescription>
        <SidebarProvider className="items-start flex overflow-hidden" style={{ height: "100%" }}>
          <Sidebar collapsible="none" className="hidden md:flex h-full">
            <SidebarContent className="overflow-y-auto h-full">
              <SidebarGroup>
                <SidebarGroupLabel>General</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.general.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>Management</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.management.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>Security</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.security.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              <SidebarSeparator />

              <SidebarGroup>
                <SidebarGroupLabel>System</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationData.system.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activeSection === item.id}
                        >
                          <button onClick={() => setActiveSection(item.id)}>
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex items-center justify-between w-full px-6">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink href="#">Settings</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{activeSectionData?.name}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onOpenChange?.(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={loading}>
                    {loading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save Changes
                  </Button>
                </div>
              </div>
            </header>

            <ScrollArea className="flex-1">
              <div className="p-6">
                {renderContent()}
              </div>
            </ScrollArea>
          </main>
        </SidebarProvider>
      </DialogContentWide>
    </Dialog>
  )
}