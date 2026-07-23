
import { useMemo } from 'react';
import { addHours, addDays } from 'date-fns';
import { SnoozedClient } from './snoozed-client';

export default function SnoozedPage() {
  // In a real app, this would use a query hook to fetch from a database
  // For now, using sample data
  const snoozedEmails = useMemo(() => [
    {
      id: '1',
      from: 'john@company.com',
      fromName: 'John Smith',
      subject: 'Budget Review Meeting',
      preview: 'Hi team, I wanted to follow up on our budget review discussion from last week...',
      originalDate: new Date(Date.now() - 86400000),
      snoozedUntil: addHours(new Date(), 3),
      labels: ['Work'],
      isRead: true
    },
    {
      id: '2',
      from: 'sarah@client.com',
      fromName: 'Sarah Johnson',
      subject: 'Project Timeline Update',
      preview: 'Please find attached the updated project timeline with the revised milestones...',
      originalDate: new Date(Date.now() - 172800000),
      snoozedUntil: addDays(new Date(), 1),
      labels: ['Work', 'Important'],
      isRead: false
    },
    {
      id: '3',
      from: 'newsletter@techdigest.com',
      fromName: 'Tech Digest',
      subject: 'Your Weekly Tech Roundup',
      preview: 'This week in tech: AI breakthroughs, new frameworks, and industry insights...',
      originalDate: new Date(Date.now() - 259200000),
      snoozedUntil: addDays(new Date(), 2),
      labels: ['Newsletter'],
      isRead: true
    },
    {
      id: '4',
      from: 'mike@partner.com',
      fromName: 'Mike Wilson',
      subject: 'Contract Review',
      preview: 'I\'ve reviewed the contract terms and have a few suggestions for amendments...',
      originalDate: new Date(Date.now() - 345600000),
      snoozedUntil: addHours(new Date(), 6),
      labels: ['Work', 'Finance'],
      isRead: false
    },
    {
      id: '5',
      from: 'travel@airline.com',
      fromName: 'SkyLine Airlines',
      subject: 'Flight Confirmation - NYC to LAX',
      preview: 'Your flight has been confirmed. Booking reference: ABC123. Departure: Dec 15...',
      originalDate: new Date(Date.now() - 432000000),
      snoozedUntil: addDays(new Date(), 5),
      labels: ['Travel'],
      isRead: true
    }
  ], []);

  return <SnoozedClient initialEmails={snoozedEmails} />;
}
