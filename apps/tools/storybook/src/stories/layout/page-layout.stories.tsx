import type { Meta, StoryObj } from '@storybook/react';
import { Clock, Download, Palmtree, Users } from 'lucide-react';

import { DashboardPage, DetailHeader, DetailPage, TabBody } from '@weldsuite/ui/components/page-layout';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { EmptyText } from '@weldsuite/ui/components/empty-state';

const meta = {
  title: 'Layout/PageLayout',
  component: DashboardPage,
  parameters: { layout: 'fullscreen' },
  args: {
    title: 'WeldHR',
    children: null,
  },
} satisfies Meta<typeof DashboardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `DashboardPage` + `KpiGrid` + `SectionCard`: a module's overview. */
export const Dashboard: Story = {
  render: () => (
    <div className="h-[640px] bg-muted/30">
      <DashboardPage
        title="WeldHR"
        description="Who is in, who is out, and what needs your attention."
        actions={
          <Button variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        }
      >
        <KpiGrid>
          <KpiCard label="Headcount" value={48} icon={Users} />
          <KpiCard label="Clocked in today" value={31} icon={Clock} />
          <KpiCard label="On leave today" value={3} icon={Palmtree} />
          <KpiCard label="Open requests" value={5} tone="warning" hint="2 waiting longer than 3 days" />
        </KpiGrid>
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard title="Upcoming leave">
            <EmptyText>Nobody is on leave in the next two weeks.</EmptyText>
          </SectionCard>
          <SectionCard title="Birthdays">
            <EmptyText>No birthdays this month.</EmptyText>
          </SectionCard>
        </div>
      </DashboardPage>
    </div>
  ),
};

/** `DetailPage` + `DetailHeader` + `FieldGrid`: a record page. */
export const RecordPage: Story = {
  render: () => (
    <div className="h-[520px]">
      <DetailPage>
        <DetailHeader
          onBack={() => undefined}
          leading={
            <Avatar className="h-12 w-12">
              <AvatarFallback>JD</AvatarFallback>
            </Avatar>
          }
          title="Jane Doe"
          badges={<Badge variant="success">Active</Badge>}
          subtitle="Product designer · Amsterdam"
          actions={
            <>
              <Button variant="outline" size="sm">
                Edit
              </Button>
              <Button size="sm">Request leave</Button>
            </>
          }
        />
        <SectionCard title="Details">
          <FieldGrid
            fields={[
              { label: 'Email', value: 'jane@acme.com' },
              { label: 'Start date', value: '3 March 2024' },
              { label: 'Manager', value: 'Sam Lee' },
              { label: 'Contract', value: null },
            ]}
          />
        </SectionCard>
      </DetailPage>
    </div>
  ),
};

export const HeaderOnly: Story = {
  render: () => (
    <div className="w-[720px] p-6">
      <DetailHeader title="Spring outreach" badges={<Badge variant="secondary">Draft</Badge>} subtitle="3 steps · 240 prospects" />
    </div>
  ),
};

/** `TabBody` pads a tab section that is not a full-bleed list. */
export const TabSection: Story = {
  render: () => (
    <div className="w-[720px] border">
      <TabBody>
        <SectionCard title="Notes">
          <p className="text-sm">Prefers to be contacted by email.</p>
        </SectionCard>
      </TabBody>
    </div>
  ),
};
