"use client"

import * as React from "react"
import { Plus, Copy, MoreVertical } from "lucide-react"
import { Button } from "./button"
import { Card } from "./card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { Badge } from "./badge"

// Mock data
const mockApiKeys = [
  { id: 1, name: "Production API", key: "sk_live_...abc123", created: "2024-01-15", lastUsed: "Today", status: "active" },
  { id: 2, name: "Development API", key: "sk_test_...xyz789", created: "2024-02-01", lastUsed: "Yesterday", status: "active" },
  { id: 3, name: "Mobile App Key", key: "sk_mob_...def456", created: "2024-01-20", lastUsed: "3 days ago", status: "active" },
  { id: 4, name: "Legacy Integration", key: "sk_old_...ghi789", created: "2023-12-01", lastUsed: "1 month ago", status: "revoked" },
]

export function ApiKeysSection() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between">
        <div>
          <h3 className="text-lg font-semibold">API Keys</h3>
          <p className="text-sm text-muted-foreground">Manage your API keys for programmatic access</p>
        </div>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Generate Key
        </Button>
      </div>

      <Card>
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
            {mockApiKeys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-muted px-2 py-1 rounded">{key.key}</code>
                    <Button variant="ghost" size="icon" className="h-6 w-6">
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>{key.created}</TableCell>
                <TableCell>{key.lastUsed}</TableCell>
                <TableCell>
                  <Badge variant={key.status === "active" ? "default" : "secondary"}>
                    {key.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
