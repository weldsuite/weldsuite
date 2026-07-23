"use client"

import * as React from "react"
import {
  UserPlus,
  Search,
  MoreVertical,
  Edit,
  Mail,
  Trash,
  Crown,
} from "lucide-react"
import { Button } from "./button"
import { Input } from "./input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { Card } from "./card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { Avatar, AvatarFallback } from "./avatar"
import { Badge } from "./badge"
import { Checkbox } from "./checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu"

// Mock data
const mockUsers = [
  { id: 1, name: "John Doe", email: "john@example.com", role: "Admin", status: "active", lastActive: "2 min ago", avatar: "JD" },
  { id: 2, name: "Jane Smith", email: "jane@example.com", role: "Editor", status: "active", lastActive: "1 hour ago", avatar: "JS" },
  { id: 3, name: "Bob Johnson", email: "bob@example.com", role: "Viewer", status: "inactive", lastActive: "2 days ago", avatar: "BJ" },
  { id: 4, name: "Alice Brown", email: "alice@example.com", role: "Editor", status: "active", lastActive: "5 min ago", avatar: "AB" },
  { id: 5, name: "Charlie Wilson", email: "charlie@example.com", role: "Admin", status: "pending", lastActive: "Never", avatar: "CW" },
]

export function UsersSection() {
  const [selectedUsers, setSelectedUsers] = React.useState<number[]>([])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search users..." className="pl-10 w-80" />
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
        </div>
        <Button>
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
              <TableHead>Status</TableHead>
              <TableHead>Last Active</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockUsers.map((user) => (
              <TableRow key={user.id} className="h-10">
                <TableCell className="py-2">
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
                <TableCell className="py-2">
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
                <TableCell className="py-2">
                  <Badge variant={user.role === "Admin" ? "default" : "secondary"}>
                    {user.role === "Admin" && <Crown className="h-3 w-3 mr-1" />}
                    {user.role}
                  </Badge>
                </TableCell>
                <TableCell className="py-2">
                  <Badge
                    variant={
                      user.status === "active" ? "default" :
                      user.status === "inactive" ? "secondary" :
                      "outline"
                    }
                  >
                    {user.status}
                  </Badge>
                </TableCell>
                <TableCell className="py-2 text-muted-foreground">{user.lastActive}</TableCell>
                <TableCell className="py-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
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
                      <DropdownMenuItem className="text-destructive">
                        <Trash className="h-4 w-4 mr-2" />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
