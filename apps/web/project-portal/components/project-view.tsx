import type { ProjectPageData } from '@/lib/portal'
import { WaitingForYou } from '@/components/approvals'
import { Messages } from '@/components/messages'
import { ProjectHeader, StatTiles } from '@/components/project-overview'
import { ChangeRequests, Deliverables, Milestones } from '@/components/register-lists'
import { SharedFiles } from '@/components/shared-files'
import { LatestUpdate } from '@/components/status-report'

/**
 * The project page: header, four tiles, then two columns. On a wide screen the
 * left column is what asks for something (waiting, milestones, deliverables,
 * changes, documents) and the right one is the story (latest update,
 * messages). On a phone it is one column in reading order: what waits for the
 * contact, then the latest update, and so on; each section's `order` is that
 * order, and the columns only group them for the wide layout (`contents`
 * leaves the sections in the one grid).
 */
export function ProjectView({
  workspace,
  workspaceName,
  data,
}: Readonly<{ workspace: string; workspaceName: string; data: ProjectPageData }>) {
  const { project, approvals } = data

  return (
    <div className="flex flex-col gap-4">
      <ProjectHeader workspace={workspace} workspaceName={workspaceName} project={project} />
      <StatTiles project={project} approvals={approvals} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <WaitingForYou workspace={workspace} approvals={approvals} className="order-1 lg:order-none" />
          <Milestones
            milestones={project.milestones}
            nextId={project.nextMilestone?.id ?? null}
            className="order-3 lg:order-none"
          />
          <Deliverables deliverables={project.deliverables} className="order-4 lg:order-none" />
          <ChangeRequests changeRequests={project.changeRequests} className="order-5 lg:order-none" />
          <SharedFiles
            workspace={workspace}
            projectId={project.id}
            documents={data.documents}
            files={data.files}
            className="order-6 lg:order-none"
          />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <LatestUpdate
            workspace={workspace}
            projectId={project.id}
            report={project.latestReport}
            className="order-2 lg:order-none"
          />
          <Messages
            workspace={workspace}
            projectId={project.id}
            first={data.messages}
            className="order-7 lg:order-none"
          />
        </div>
      </div>
    </div>
  )
}
