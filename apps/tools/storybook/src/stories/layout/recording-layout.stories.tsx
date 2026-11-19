import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Captions, MoreVertical, ScrollText, Search, Users, Video } from "lucide-react";

import {
  RecordingHeader,
  RecordingLayout,
  RecordingTabPanel,
  RecordingTabStrip,
} from "@weldsuite/ui/components/recording-layout";
import { Button } from "@weldsuite/ui/components/button";

const meta = {
  title: "Layout/RecordingLayout",
  component: RecordingLayout,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RecordingLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ----------------------------- helpers ----------------------------- */

function Player({ label }: Readonly<{ label: string }>) {
  return (
    <div className="p-4 pb-0">
      <div className="flex aspect-video items-center justify-center rounded-lg bg-gray-900 text-sm text-white/70">{label}</div>
    </div>
  );
}

function Recording({
  icon,
  title,
  subtitle,
  tabs,
  actions,
  sidebar,
}: Readonly<{
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  tabs: { id: string; label: string; icon: React.ComponentType<{ className?: string }>; body: string }[];
  actions: React.ReactNode;
  sidebar?: React.ReactNode;
}>) {
  const [tab, setTab] = React.useState(tabs[0]!.id);
  const idPrefix = React.useId();
  return (
    <div className="h-[720px]">
      <RecordingLayout
        header={<RecordingHeader onBack={() => {}} icon={icon} title={title} onRename={() => {}} titleLabel="Title" subtitle={subtitle} actions={actions} />}
        sidebar={sidebar}
      >
        <Player label={title} />
        <div className="pb-4">
          <RecordingTabStrip
            tabs={tabs}
            value={tab}
            onValueChange={setTab}
            label={title}
            idPrefix={idPrefix}
            separated
            tools={
              <Button variant="outline" size="icon-sm" aria-label="Search">
                <Search className="h-4 w-4" />
              </Button>
            }
          />
          {tabs.map((t) => (
            <RecordingTabPanel key={t.id} idPrefix={idPrefix} value={t.id} selected={tab === t.id}>
              <p className="px-4 pt-4 text-sm text-muted-foreground">{t.body}</p>
            </RecordingTabPanel>
          ))}
        </div>
      </RecordingLayout>
    </div>
  );
}

/* ------------------------------ stories ---------------------------- */

/** A WeldMeet meeting or WeldCRM call: the video, then transcript, speakers and details. */
export const Meeting: Story = {
  args: { header: null, children: null },
  render: () => (
    <Recording
      icon={<Video className="h-4 w-4 text-muted-foreground" />}
      title="Weekly product sync"
      tabs={[
        { id: "transcript", label: "Transcript", icon: Captions, body: "The transcript, following the playhead." },
        { id: "speakers", label: "Speakers", icon: Users, body: "Who spoke, and for how long." },
        { id: "meeting", label: "Meeting", icon: Video, body: "Date, duration and participants." },
      ]}
      actions={
        <Button variant="ghost" size="icon-sm" aria-label="More">
          <MoreVertical className="h-4 w-4" />
        </Button>
      }
    />
  ),
};

/** A WeldPanel session replay: same shell, a note after the title, and a details column (timeline, info, insights). */
export const SessionReplay: Story = {
  args: { header: null, children: null },
  render: () => (
    <Recording
      title="Recording of Noah Taylor"
      subtitle="Started Nov 19, 2026, 5:35 AM"
      tabs={[
        { id: "summary", label: "Summary", icon: ScrollText, body: "What the visitor tried to do and where they got stuck." },
        { id: "pages", label: "Pages", icon: Captions, body: "The pages visited, in order." },
      ]}
      actions={null}
      sidebar={<div className="p-4 text-sm text-muted-foreground">Timeline · Info · Insights</div>}
    />
  ),
};

/** With a sidebar column, as when the assistant is open next to a meeting. */
export const WithSidebar: Story = {
  args: { header: null, children: null },
  render: () => (
    <Recording
      icon={<Video className="h-4 w-4 text-muted-foreground" />}
      title="Customer onboarding call"
      tabs={[{ id: "transcript", label: "Transcript", icon: Captions, body: "The transcript." }]}
      actions={null}
      sidebar={<div className="p-4 text-sm text-muted-foreground">Sidebar</div>}
    />
  ),
};
