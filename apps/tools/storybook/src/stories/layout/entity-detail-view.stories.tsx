import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { MoreHorizontal, Star, Phone, Mail } from "lucide-react";

import { EntityDetailView } from "@weldsuite/ui/components/entity-detail-view";
import { Button } from "@weldsuite/ui/components/button";
import { Avatar, AvatarFallback } from "@weldsuite/ui/components/avatar";
import { Badge } from "@weldsuite/ui/components/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@weldsuite/ui/components/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";

const meta = {
  title: "Layout/EntityDetailView",
  component: EntityDetailView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EntityDetailView>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ----------------------------- helpers ----------------------------- */

function MockAvatar({ label }: { label: string }) {
  return (
    <Avatar className="h-8 w-8">
      <AvatarFallback>{label}</AvatarFallback>
    </Avatar>
  );
}

function MockTabs({
  items = ["Overview", "Activity", "Notes", "Files"],
}: {
  items?: string[];
}) {
  return (
    <Tabs defaultValue={items[0]} className="w-full">
      <TabsList className="bg-transparent h-10 px-2">
        {items.map((item) => (
          <TabsTrigger key={item} value={item} className="text-sm">
            {item}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function MockContent({ rows = 30 }: { rows?: number }) {
  return (
    <div className="p-6 space-y-3 text-sm text-muted-foreground">
      {Array.from({ length: rows }).map((_, i) => (
        <p key={i}>
          Line {i + 1} — Lorem ipsum dolor sit amet, consectetur adipiscing elit.
          Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
        </p>
      ))}
    </div>
  );
}

function MockChat() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
        <div className="bg-muted rounded-md p-2">Hey, can you take a look?</div>
        <div className="bg-primary text-primary-foreground rounded-md p-2 self-end max-w-[80%] ml-auto">
          On it.
        </div>
        <div className="bg-muted rounded-md p-2">Thanks 🙏</div>
      </div>
      <div className="border-t border-border p-2">
        <input
          className="w-full bg-background rounded-md border border-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="Write a message…"
        />
      </div>
    </div>
  );
}

function MockActions() {
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Favorite">
        <Star className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Call">
        <Phone className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Email">
        <Mail className="h-4 w-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function StageBackground() {
  return (
    <div className="absolute inset-0 bg-muted/30 p-8 text-muted-foreground text-sm">
      <p className="font-medium mb-2">Background page</p>
      <p>
        This is whatever page the user was on before they opened the panel. In
        panel mode the EntityDetailView slides in over this content.
      </p>
    </div>
  );
}

/* ----------------------------- panel mode ----------------------------- */

export const PanelMode: Story = {
  render: () => {
    const [open, setOpen] = React.useState(true);
    return (
      <div className="relative h-screen w-screen">
        <StageBackground />
        <div className="absolute top-4 left-4 z-10">
          <Button onClick={() => setOpen((v) => !v)}>
            {open ? "Close panel" : "Open panel"}
          </Button>
        </div>
        <EntityDetailView
          defaultMode="panel"
          isOpen={open}
          onClose={() => setOpen(false)}
          topOffset={0}
          leftOffset={0}
          width={500}
          avatar={<MockAvatar label="AC" />}
          title={
            <span className="flex items-center gap-2">
              Acme Corp
              <Badge variant="secondary">B2B</Badge>
            </span>
          }
          subtitle="Customer • Amsterdam, NL"
          actions={<MockActions />}
          tabs={<MockTabs />}
        >
          <MockContent />
        </EntityDetailView>
      </div>
    );
  },
};

/**
 * Mirrors the /weldcrm/customers panel pattern: the caller controls `mode`
 * and decides what happens when the user clicks the expand button (typically
 * navigating to a full-page route).
 */
export const ControlledModeToggle: Story = {
  render: () => {
    const [mode, setMode] = React.useState<"panel" | "fullscreen">("panel");
    const [open, setOpen] = React.useState(true);
    return (
      <div className="relative h-screen w-screen">
        <StageBackground />
        <div className="absolute top-4 left-4 z-10 flex gap-2">
          <Button onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Open"}
          </Button>
          <Button variant="outline" onClick={() => setMode("panel")}>
            Force panel
          </Button>
          <Button variant="outline" onClick={() => setMode("fullscreen")}>
            Force fullscreen
          </Button>
        </div>
        {open && (
          <EntityDetailView
            mode={mode}
            onToggleExpand={() =>
              setMode((m) => (m === "panel" ? "fullscreen" : "panel"))
            }
            isOpen={open}
            onClose={() => setOpen(false)}
            topOffset={0}
            leftOffset={0}
            width={500}
            avatar={<MockAvatar label="AC" />}
            title="Acme Corp"
            subtitle="Customer • controlled mode"
            actions={<MockActions />}
            tabs={<MockTabs />}
          >
            <MockContent />
          </EntityDetailView>
        )}
      </div>
    );
  },
};

export const PanelModeWithSidebar: Story = {
  render: () => {
    const [open, setOpen] = React.useState(true);
    return (
      <div className="relative h-screen w-screen">
        <StageBackground />
        <div className="absolute top-4 right-4 z-10">
          <Button onClick={() => setOpen((v) => !v)}>
            {open ? "Close panel" : "Open panel"}
          </Button>
        </div>
        <EntityDetailView
          defaultMode="panel"
          isOpen={open}
          onClose={() => setOpen(false)}
          topOffset={0}
          width={520}
          avatar={<MockAvatar label="TS" />}
          title="Ship the new onboarding flow"
          subtitle="Task • Due Friday"
          actions={<MockActions />}
          tabs={<MockTabs items={["Details", "Subtasks", "Activity"]} />}
          sidebar={<MockChat />}
          sidebarDefaultSize={280}
          sidebarMinSize={140}
          sidebarPersistKey="story-panel-chat"
        >
          <MockContent />
        </EntityDetailView>
      </div>
    );
  },
};

export const PanelModeStacked: Story = {
  render: () => {
    return (
      <div className="relative h-screen w-screen">
        <StageBackground />
        <EntityDetailView
          defaultMode="panel"
          isOpen
          onClose={() => alert("close")}
          onBack={() => alert("back to parent panel")}
          topOffset={0}
          width={500}
          avatar={<MockAvatar label="JD" />}
          title="John Doe"
          subtitle="Contact at Acme Corp"
          actions={<MockActions />}
          tabs={<MockTabs items={["Overview", "Activity"]} />}
        >
          <MockContent rows={10} />
        </EntityDetailView>
      </div>
    );
  },
};

export const PanelModeLoading: Story = {
  render: () => (
    <div className="relative h-screen w-screen">
      <StageBackground />
      <EntityDetailView
        mode="panel"
        isOpen
        onClose={() => {}}
        topOffset={0}
        width={500}
        avatar={<MockAvatar label="AC" />}
        title="Acme Corp"
        subtitle="Loading…"
        actions={<MockActions />}
        tabs={<MockTabs />}
        loading
      >
        <MockContent />
      </EntityDetailView>
    </div>
  ),
};

/* --------------------------- fullscreen mode --------------------------- */

export const FullscreenMode: Story = {
  render: () => (
    <div className="h-screen w-screen">
      <EntityDetailView
        defaultMode="fullscreen"
        avatar={<MockAvatar label="AC" />}
        title="Acme Corp"
        subtitle="Customer • Amsterdam, NL"
        actions={<MockActions />}
        tabs={<MockTabs />}
        onClose={() => alert("close")}
      >
        <MockContent />
      </EntityDetailView>
    </div>
  ),
};

export const FullscreenModeWithSidebar: Story = {
  render: () => (
    <div className="h-screen w-screen">
      <EntityDetailView
        defaultMode="fullscreen"
        avatar={<MockAvatar label="AC" />}
        title="Acme Corp"
        subtitle="Customer"
        actions={<MockActions />}
        tabs={
          <MockTabs
            items={["Overview", "Activity", "Contacts", "Emails", "Deals"]}
          />
        }
        sidebar={<MockChat />}
        sidebarDefaultSize={420}
        sidebarPersistKey="story-fullscreen-chat"
        onClose={() => alert("close")}
      >
        <MockContent />
      </EntityDetailView>
    </div>
  ),
};

export const FullscreenModeNoTabs: Story = {
  render: () => (
    <div className="h-screen w-screen">
      <EntityDetailView
        defaultMode="fullscreen"
        avatar={<MockAvatar label="IV" />}
        title="Invoice INV-2025-014"
        subtitle="€ 1,240.00 • Paid"
        actions={<MockActions />}
        onClose={() => alert("close")}
      >
        <MockContent rows={20} />
      </EntityDetailView>
    </div>
  ),
};

export const CustomActions: Story = {
  render: () => (
    <div className="h-screen w-screen">
      <EntityDetailView
        defaultMode="fullscreen"
        avatar={<MockAvatar label="JD" />}
        title="John Doe"
        subtitle="Contact"
        actions={
          <>
            <Button size="sm" variant="outline">
              Share
            </Button>
            <Button size="sm">Save</Button>
          </>
        }
        tabs={<MockTabs items={["Overview", "Notes"]} />}
        onClose={() => alert("close")}
      >
        <MockContent rows={15} />
      </EntityDetailView>
    </div>
  ),
};
