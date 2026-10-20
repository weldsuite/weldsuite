import { Cpu } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { formatDateTime } from '@/lib/billing-format';
import { computeState, type EndpointView, type ProjectLiveState } from '@/lib/database-moves';
import { adminCopy, fill } from '@/lib/i18n';
import { ComputeBadge } from './move-presentation';
import { Dash, Mono, Notice } from './presentation';

function endpointState(endpoint: EndpointView) {
  return computeState({ endpoints: [endpoint], error: null });
}

/** The live compute of one Neon project: each endpoint's state, size and suspend setting. */
export function ComputeCard({ project, checkedAt }: Readonly<{ project: ProjectLiveState; checkedAt: string }>) {
  const t = adminCopy().databases.compute;

  const size = (endpoint: EndpointView) =>
    endpoint.minCu === null || endpoint.maxCu === null ? (
      <Dash />
    ) : (
      fill(t.size, { min: endpoint.minCu, max: endpoint.maxCu })
    );
  const suspendAfter = (endpoint: EndpointView) => {
    if (endpoint.suspendTimeoutSeconds === null) return <Dash />;
    // Neon: -1 never suspends, 0 means its default (300 s).
    if (endpoint.suspendTimeoutSeconds < 0) return t.neverSuspends;
    if (endpoint.suspendTimeoutSeconds === 0) return t.defaultSuspend;
    return fill(t.seconds, { count: endpoint.suspendTimeoutSeconds });
  };

  return (
    <Card className="py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.title}</h2>
            <ComputeBadge state={computeState(project)} />
          </div>
          <span className="text-xs text-muted-foreground">
            {fill(t.checkedAt, { time: formatDateTime(checkedAt) })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t.hint}</p>

        {project.error && <Notice tone="warning">{fill(t.projectError, { message: project.error })}</Notice>}
        {!project.error && project.endpoints.length === 0 && (
          <p className="text-sm text-muted-foreground">{t.noEndpoints}</p>
        )}
        {project.endpoints.length > 0 && (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">{t.endpoint.endpoint}</TableHead>
                  <TableHead className="w-28 text-[13.5px]">{t.endpoint.type}</TableHead>
                  <TableHead className="w-28 text-[13.5px]">{t.endpoint.state}</TableHead>
                  <TableHead className="w-36 text-[13.5px]">{t.endpoint.size}</TableHead>
                  <TableHead className="w-32 text-[13.5px]">{t.endpoint.suspendAfter}</TableHead>
                  <TableHead className="w-44 text-[13.5px]">{t.endpoint.lastActive}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {project.endpoints.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell className="py-2.5">
                      <Mono>{endpoint.id}</Mono>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs">{endpoint.type}</TableCell>
                    <TableCell className="py-2.5">
                      <ComputeBadge state={endpointState(endpoint)} />
                    </TableCell>
                    <TableCell className="py-2.5 text-xs tabular-nums">{size(endpoint)}</TableCell>
                    <TableCell className="py-2.5 text-xs tabular-nums">{suspendAfter(endpoint)}</TableCell>
                    <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                      {endpoint.lastActive ? formatDateTime(endpoint.lastActive) : <Dash />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
