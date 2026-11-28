import type { Meta, StoryObj } from '@storybook/react';
import { Banknote, BellRing, Eye, FilePlus2, Mail, MailWarning } from 'lucide-react';

import { ActivityTimeline } from '@weldsuite/ui/components/activity-timeline';

const meta = {
  title: 'Data Display/ActivityTimeline',
  component: ActivityTimeline,
  args: { label: 'What happened' },
} satisfies Meta<typeof ActivityTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An invoice's life, oldest first: the last item is still to come and is drawn dashed. */
export const Invoice: Story = {
  args: {
    items: [
      { id: 'created', icon: FilePlus2, title: 'Created from quote OFF-0012', time: '3 Nov 2026, 09:12', dateTime: '2026-11-03T09:12:00Z' },
      { id: 'sent', icon: Mail, tone: 'info', title: 'E-mailed', description: 'To klant@example.test', time: '3 Nov 2026, 09:20' },
      { id: 'viewed', icon: Eye, tone: 'info', title: 'Viewed online 3 times', time: 'Last on 5 Nov 2026, 14:02' },
      { id: 'remind', icon: BellRing, tone: 'warning', title: 'Reminder 1 sent', description: 'To klant@example.test', time: '24 Nov 2026' },
      { id: 'next', icon: BellRing, upcoming: true, srPrefix: 'Planned:', title: 'Reminder 2 is sent automatically', time: '8 Dec 2026' },
    ],
  },
};

export const Bounced: Story = {
  args: {
    items: [
      { id: 'sent', icon: Mail, tone: 'info', title: 'E-mailed', description: 'To klant@example.test', time: '3 Nov 2026' },
      { id: 'bounced', icon: MailWarning, tone: 'danger', title: 'Not delivered', description: 'The mailbox does not exist', time: '3 Nov 2026' },
      { id: 'paid', icon: Banknote, tone: 'success', title: 'Paid in full', time: '9 Nov 2026' },
    ],
  },
};
