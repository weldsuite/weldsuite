"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "./button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Badge } from "./badge"
import { Progress } from "./progress"

// Mock data
const mockWorkspaces = [
  { id: 1, name: "Marketing Team", members: 12, plan: "Pro", storage: "45 GB", storagePercent: 45, status: "active" },
  { id: 2, name: "Development", members: 25, plan: "Enterprise", storage: "120 GB", storagePercent: 60, status: "active" },
  { id: 3, name: "Sales Department", members: 8, plan: "Pro", storage: "23 GB", storagePercent: 23, status: "active" },
  { id: 4, name: "Design Studio", members: 6, plan: "Basic", storage: "15 GB", storagePercent: 75, status: "trial" },
]

export function WorkspacesSection() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">Your Workspaces</h3>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          New Workspace
        </Button>
      </div>
      <div className="grid gap-4">
        {mockWorkspaces.map((workspace) => (
          <Card key={workspace.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{workspace.name}</CardTitle>
                  <CardDescription>{workspace.members} members</CardDescription>
                </div>
                <Badge variant={workspace.status === "trial" ? "secondary" : "default"}>
                  {workspace.plan}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Storage Usage</span>
                  <span>{workspace.storage}</span>
                </div>
                <Progress value={workspace.storagePercent} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm">Manage</Button>
                <Button variant="outline" size="sm">Settings</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
