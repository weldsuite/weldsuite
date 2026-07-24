
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Plus } from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card"
import { Badge } from "@weldsuite/ui/components/badge"
import { Progress } from "@weldsuite/ui/components/progress"

// Mock data
const mockWorkspaces = [
  { id: 1, name: "Marketing Team", members: 12, plan: "Pro", storage: "45 GB", storagePercent: 45, status: "active" },
  { id: 2, name: "Development", members: 25, plan: "Enterprise", storage: "120 GB", storagePercent: 60, status: "active" },
  { id: 3, name: "Sales Department", members: 8, plan: "Pro", storage: "23 GB", storagePercent: 23, status: "active" },
  { id: 4, name: "Design Studio", members: 6, plan: "Basic", storage: "15 GB", storagePercent: 75, status: "trial" },
]

export function WorkspacesSection() {
  const t = useTranslations()
  return (
    <div className="space-y-6">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">{t('sweep.settings.workspacesSection.yourWorkspaces')}</h3>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          {t('sweep.settings.workspacesSection.newWorkspace')}
        </Button>
      </div>
      <div className="grid gap-4">
        {mockWorkspaces.map((workspace) => (
          <Card key={workspace.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{workspace.name}</CardTitle>
                  <CardDescription>{t('sweep.settings.workspacesSection.memberCount', { count: workspace.members })}</CardDescription>
                </div>
                <Badge variant={workspace.status === "trial" ? "secondary" : "default"}>
                  {workspace.plan}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{t('sweep.settings.workspacesSection.storageUsage')}</span>
                  <span>{workspace.storage}</span>
                </div>
                <Progress value={workspace.storagePercent} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm">{t('sweep.settings.workspacesSection.manage')}</Button>
                <Button variant="outline" size="sm">{t('sweep.settings.workspacesSection.settings')}</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
