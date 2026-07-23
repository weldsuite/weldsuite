import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import {
  ChevronLeft,
  Star,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  MoreVertical,
  Paperclip,
  Archive,
  Save,
  WifiOff,
  ChevronUp,
  ChevronDown,
  Lock,
} from 'lucide-react-native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import EmailHtmlView from '@/components/EmailHtmlView';
import { useMail, type EmailDetail, type ThreadMessage } from '@/contexts/MailContext';
import ComposeEmailForm from '@/components/mail/ComposeEmailForm';
import { useToast } from '@/contexts/ToastContext';


// Sample email details for development/demo purposes
const SAMPLE_EMAIL_DETAILS: Record<string, EmailDetail> = {
  'email-1': {
    id: 'email-1',
    emailAccountId: 'account-1',
    from: 'Sarah Johnson',
    fromName: 'Sarah Johnson',
    fromEmail: 'sarah.johnson@company.com',
    to: 'john.doe@weldsuite.com',
    subject: 'Q4 Sales Report Ready for Review',
    preview: 'Hi John, I\'ve completed the Q4 sales report and attached it for your review.',
    date: 'Today',
    time: '2:45 PM',
    isRead: true,
    isStarred: true,
    hasAttachment: true,
    labels: ['INBOX'],
    category: 'primary',
    body: 'Hi John,\n\nI\'ve completed the Q4 sales report and attached it for your review. Please let me know if you need any changes or have questions about any of the figures.\n\nKey highlights:\n• Total revenue increased by 23% compared to Q3\n• New customer acquisition up 15%\n• Customer retention rate improved to 94%\n• Average deal size grew by 12%\n\nI\'ve also included a breakdown by region and product line. The marketing team\'s campaign in the mid-Atlantic region showed particularly strong results.\n\nLet me know when you\'d like to schedule a call to discuss the findings.\n\nBest regards,\nSarah',
    receivedAt: new Date().toISOString(),
    attachments: [
      {
        id: 'att-1',
        filename: 'Q4_Sales_Report_2024.pdf',
        contentType: 'application/pdf',
        size: 2458624,
      },
      {
        id: 'att-2',
        filename: 'Regional_Breakdown.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 156842,
      },
    ],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-2': {
    id: 'email-2',
    emailAccountId: 'account-1',
    from: 'Michael Chen',
    fromName: 'Michael Chen',
    fromEmail: 'michael.chen@supplier.com',
    to: 'john.doe@weldsuite.com',
    subject: 'Re: Inventory Order #4521 - Delivery Update',
    preview: 'Good news! Your order has been shipped and is expected to arrive by Friday.',
    date: 'Today',
    time: '11:30 AM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'primary',
    body: 'Hi John,\n\nGood news! Your order has been shipped and is expected to arrive by Friday.\n\nTracking number: 1Z999AA10123456784\nCarrier: UPS\nEstimated delivery: December 13, 2024\n\nYou can track your package at: https://ups.com/track\n\nThe order includes:\n- 500 units SKU-A234 (Premium Widget)\n- 250 units SKU-B891 (Standard Bracket)\n- 100 units SKU-C456 (Deluxe Assembly Kit)\n\nPlease let me know if you need anything else. We appreciate your business!\n\nBest,\nMichael Chen\nAccount Manager\nSupplier Corp.',
    receivedAt: new Date().toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-3': {
    id: 'email-3',
    emailAccountId: 'account-1',
    from: 'LinkedIn',
    fromName: 'LinkedIn',
    fromEmail: 'notifications@linkedin.com',
    to: 'john.doe@weldsuite.com',
    subject: '5 people viewed your profile this week',
    preview: 'See who\'s checking out your profile and discover new opportunities.',
    date: 'Today',
    time: '9:15 AM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'social',
    body: 'Hi John,\n\n5 people viewed your profile this week.\n\nSee who\'s checking out your profile and discover new opportunities. Your profile strength is expert.\n\nTop viewers by industry:\n• Technology - 2 viewers\n• Manufacturing - 2 viewers\n• Retail - 1 viewer\n\nTo see who viewed your profile, visit LinkedIn.\n\nProfile tips:\n- Add a cover photo to make your profile stand out\n- Update your skills to highlight your expertise\n\nBest,\nThe LinkedIn Team',
    receivedAt: new Date().toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'low',
  },
  'email-4': {
    id: 'email-4',
    emailAccountId: 'account-1',
    from: 'Emily Rodriguez',
    fromName: 'Emily Rodriguez',
    fromEmail: 'emily@marketing.agency',
    to: 'john.doe@weldsuite.com',
    subject: 'New Marketing Campaign Proposal',
    preview: 'Hi John, Following our call yesterday, I\'m sending over the marketing campaign proposal.',
    date: 'Yesterday',
    time: '4:20 PM',
    isRead: true,
    isStarred: false,
    hasAttachment: true,
    labels: ['INBOX'],
    category: 'primary',
    body: 'Hi John,\n\nFollowing our call yesterday, I\'m sending over the marketing campaign proposal for next quarter.\n\nWe\'ve included three different approaches:\n\n1. Digital Focus Strategy\n   - Social media advertising\n   - Email marketing automation\n   - Content marketing\n   Budget: $45,000/month\n\n2. Omnichannel Approach\n   - Digital + print advertising\n   - Event sponsorships\n   - Influencer partnerships\n   Budget: $75,000/month\n\n3. Premium Brand Building\n   - Full-service campaign\n   - Video production\n   - PR and media relations\n   Budget: $120,000/month\n\nI\'d recommend we schedule a follow-up call to discuss which approach aligns best with your Q1 goals.\n\nLooking forward to your feedback!\n\nBest,\nEmily Rodriguez\nSenior Account Director',
    receivedAt: new Date(Date.now() - 86400000).toISOString(),
    attachments: [
      {
        id: 'att-3',
        filename: 'Marketing_Proposal_Q1_2025.pdf',
        contentType: 'application/pdf',
        size: 5242880,
      },
    ],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-5': {
    id: 'email-5',
    emailAccountId: 'account-1',
    from: 'Amazon Web Services',
    fromName: 'Amazon Web Services',
    fromEmail: 'aws-notifications@amazon.com',
    to: 'john.doe@weldsuite.com',
    subject: 'Your AWS monthly billing statement is available',
    preview: 'Your AWS statement for November 2024 is now available. Total charges: $127.45.',
    date: 'Yesterday',
    time: '8:00 AM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'updates',
    body: 'Hello,\n\nYour AWS statement for November 2024 is now available.\n\nTotal charges: $127.45\n\nService breakdown:\n• Amazon EC2: $67.23\n• Amazon S3: $24.89\n• Amazon RDS: $31.50\n• Amazon CloudWatch: $3.83\n\nPayment will be processed automatically using your default payment method.\n\nView your bill in the AWS Console for a detailed breakdown of your charges.\n\nThank you for using Amazon Web Services.\n\nAmazon Web Services',
    receivedAt: new Date(Date.now() - 86400000).toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-6': {
    id: 'email-6',
    emailAccountId: 'account-1',
    from: 'David Park',
    fromName: 'David Park',
    fromEmail: 'david.park@client.org',
    to: 'john.doe@weldsuite.com',
    subject: 'Project Timeline Discussion',
    preview: 'John, can we schedule a call to discuss the project timeline?',
    date: 'Yesterday',
    time: '3:45 PM',
    isRead: true,
    isStarred: true,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'primary',
    body: 'John,\n\nCan we schedule a call to discuss the project timeline? I have some concerns about the delivery date we agreed upon.\n\nSpecifically, I\'d like to discuss:\n\n1. The integration testing phase - seems shorter than usual\n2. The buffer time for unexpected issues\n3. Resource allocation during the holiday period\n\nI\'m available this week:\n- Thursday 2-4 PM\n- Friday 10 AM - 12 PM\n\nOr next week:\n- Monday 9-11 AM\n- Tuesday 1-3 PM\n\nPlease let me know what works for you.\n\nThanks,\nDavid Park\nProject Manager',
    receivedAt: new Date(Date.now() - 86400000).toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'high',
  },
  'email-7': {
    id: 'email-7',
    emailAccountId: 'account-1',
    from: 'Shopify',
    fromName: 'Shopify',
    fromEmail: 'noreply@shopify.com',
    to: 'john.doe@weldsuite.com',
    subject: 'Black Friday sale: 50% off all apps',
    preview: 'Don\'t miss out on our biggest sale of the year!',
    date: '2 days ago',
    time: '10:00 AM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'promotions',
    body: 'Don\'t miss out on our biggest sale of the year!\n\nGet 50% off all Shopify apps and themes. Offer valid until December 15th.\n\nTop deals:\n• Premium themes - starting at $90 (was $180)\n• Analytics apps - 50% off\n• Marketing tools - 50% off\n• Inventory management - 50% off\n\nUse code: BLACKFRIDAY50\n\nThis is our best offer of the year. Don\'t wait!\n\nShop Now\n\n- The Shopify Team',
    receivedAt: new Date(Date.now() - 172800000).toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'low',
  },
  'email-8': {
    id: 'email-8',
    emailAccountId: 'account-1',
    from: 'HR Department',
    fromName: 'HR Department',
    fromEmail: 'hr@weldsuite.com',
    to: 'all-staff@weldsuite.com',
    subject: 'Holiday Schedule 2024 - Action Required',
    preview: 'Dear Team, Please review and submit your holiday preferences by December 1st.',
    date: '2 days ago',
    time: '2:30 PM',
    isRead: true,
    isStarred: false,
    hasAttachment: true,
    labels: ['INBOX'],
    category: 'updates',
    body: 'Dear Team,\n\nPlease review and submit your holiday preferences by December 1st.\n\nThe attached document contains all the details regarding:\n\n1. Office closure dates\n   - December 24-25 (Christmas)\n   - December 31 - January 1 (New Year)\n\n2. Holiday PTO policy\n   - Unused PTO must be used by year end\n   - Carryover limit: 5 days maximum\n\n3. Coverage requirements\n   - Each department needs minimum staffing\n   - Please coordinate with your team\n\n4. How to submit preferences\n   - Use the HR portal\n   - Deadline: December 1st, 5 PM\n\nIf you have any questions, please reach out to your HR representative.\n\nBest regards,\nHR Department',
    receivedAt: new Date(Date.now() - 172800000).toISOString(),
    attachments: [
      {
        id: 'att-4',
        filename: 'Holiday_Schedule_2024.pdf',
        contentType: 'application/pdf',
        size: 892416,
      },
    ],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-9': {
    id: 'email-9',
    emailAccountId: 'account-1',
    from: 'GitHub',
    fromName: 'GitHub',
    fromEmail: 'notifications@github.com',
    to: 'john.doe@weldsuite.com',
    subject: '[weldsuite/app] Pull request #234: Feature implementation',
    preview: '@developer mentioned you in a comment: "Hey @johndoe, could you review this PR?"',
    date: '3 days ago',
    time: '5:15 PM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'updates',
    body: '@developer mentioned you in a comment:\n\n"Hey @johndoe, could you review this PR when you get a chance? It includes the new authentication flow we discussed."\n\n---\n\nPull Request #234\nFeature: Implement new authentication flow\n\nChanges:\n• Added OAuth2 support\n• Implemented refresh token logic\n• Updated user session handling\n• Added unit tests (95% coverage)\n\nFiles changed: 23\nAdditions: +1,247\nDeletions: -342\n\nView on GitHub: https://github.com/weldsuite/app/pull/234',
    receivedAt: new Date(Date.now() - 259200000).toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-10': {
    id: 'email-10',
    emailAccountId: 'account-1',
    from: 'Lisa Wang',
    fromName: 'Lisa Wang',
    fromEmail: 'lisa.wang@partner.io',
    to: 'john.doe@weldsuite.com',
    subject: 'Partnership Opportunity Discussion',
    preview: 'Hi John, I hope this email finds you well. I wanted to reach out about a partnership.',
    date: '3 days ago',
    time: '11:00 AM',
    isRead: true,
    isStarred: true,
    hasAttachment: true,
    labels: ['INBOX'],
    category: 'primary',
    body: 'Hi John,\n\nI hope this email finds you well.\n\nI wanted to reach out about a potential partnership opportunity between our companies. After reviewing WeldSuite\'s recent product announcements, I believe there\'s significant synergy between what you\'re building and our platform.\n\nOur company, Partner.io, provides enterprise integration solutions that could complement your suite:\n\n• 500+ pre-built integrations\n• Real-time data synchronization\n• Enterprise-grade security (SOC 2, GDPR compliant)\n• White-label options available\n\nI\'ve attached a brief overview of our partnership program and some case studies from similar collaborations.\n\nWould you be open to a 30-minute call next week to explore this further? I\'m happy to work around your schedule.\n\nLooking forward to connecting!\n\nBest regards,\nLisa Wang\nDirector of Partnerships\nPartner.io',
    receivedAt: new Date(Date.now() - 259200000).toISOString(),
    attachments: [
      {
        id: 'att-5',
        filename: 'Partnership_Overview.pdf',
        contentType: 'application/pdf',
        size: 3145728,
      },
      {
        id: 'att-6',
        filename: 'Case_Studies.pdf',
        contentType: 'application/pdf',
        size: 4194304,
      },
    ],
    isDraft: false,
    isSent: false,
    importance: 'normal',
  },
  'email-11': {
    id: 'email-11',
    emailAccountId: 'account-1',
    from: 'Slack',
    fromName: 'Slack',
    fromEmail: 'notifications@slack.com',
    to: 'john.doe@weldsuite.com',
    subject: 'You have 15 unread messages in #general',
    preview: 'Catch up on the conversation in #general.',
    date: '4 days ago',
    time: '6:00 PM',
    isRead: true,
    isStarred: false,
    hasAttachment: false,
    labels: ['INBOX'],
    category: 'social',
    body: 'Catch up on the conversation in #general.\n\nRecent messages from @team_lead, @marketing, and 3 others.\n\nPreview:\n\n@team_lead: "Great work on the release everyone! Let\'s celebrate this milestone."\n\n@marketing: "The blog post is live! Check it out and share with your networks."\n\n@sarah: "Has anyone seen the latest metrics? Numbers look promising!"\n\nOpen Slack to continue the conversation.\n\n---\nTo change your notification settings, visit slack.com/settings',
    receivedAt: new Date(Date.now() - 345600000).toISOString(),
    attachments: [],
    isDraft: false,
    isSent: false,
    importance: 'low',
  },
  'email-12': {
    id: 'email-12',
    emailAccountId: 'account-1',
    from: 'James Miller',
    fromName: 'James Miller',
    fromEmail: 'james.miller@vendor.com',
    to: 'john.doe@weldsuite.com, accounting@weldsuite.com',
    subject: 'Invoice #INV-2024-0891 - Payment Reminder',
    preview: 'Dear John, This is a friendly reminder that invoice #INV-2024-0891 is due.',
    date: '5 days ago',
    time: '9:30 AM',
    isRead: true,
    isStarred: false,
    hasAttachment: true,
    labels: ['INBOX'],
    category: 'primary',
    body: 'Dear John,\n\nThis is a friendly reminder that invoice #INV-2024-0891 for $4,500 is due on November 30th.\n\nInvoice Details:\n• Invoice Number: INV-2024-0891\n• Amount Due: $4,500.00\n• Due Date: November 30, 2024\n• Payment Terms: Net 30\n\nServices rendered:\n- Consulting services (October 2024): $3,000\n- Software licenses renewal: $1,500\n\nPayment Options:\n1. Bank Transfer (ACH)\n   Account: 1234567890\n   Routing: 021000021\n\n2. Wire Transfer\n   SWIFT: CITIUS33\n   IBAN: US12345678901234567890\n\n3. Credit Card\n   Pay online at: vendor.com/pay\n\nPlease find the invoice attached for your records.\n\nIf you have any questions, don\'t hesitate to reach out.\n\nThank you for your business!\n\nBest regards,\nJames Miller\nAccounts Receivable',
    receivedAt: new Date(Date.now() - 432000000).toISOString(),
    attachments: [
      {
        id: 'att-7',
        filename: 'Invoice_INV-2024-0891.pdf',
        contentType: 'application/pdf',
        size: 524288,
      },
    ],
    isDraft: false,
    isSent: false,
    importance: 'high',
  },
};

// Helper: extract sender name from `from` which can be a string or JSONB { email, name }
function getSenderName(from: any): string {
  if (!from) return '(No sender)';
  if (typeof from === 'string') return from;
  return from.name || from.email || '(No sender)';
}

function getSenderEmail(from: any): string {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.email || '';
}

// Collapsible quoted message for reply/forward
function QuotedMessage({ mode, from, date, subject, body }: { mode: string; from: string; date: string; subject: string; body: string }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <View style={quotedStyles.container}>
      <TouchableOpacity
        style={quotedStyles.dotsButton}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={quotedStyles.dot} />
        <View style={quotedStyles.dot} />
        <View style={quotedStyles.dot} />
      </TouchableOpacity>
      {expanded && (
        <View style={quotedStyles.content}>
          <Text style={quotedStyles.label}>
            {mode === 'forward' ? '---------- Forwarded message ---------' : '---------- Original message ---------'}
          </Text>
          <Text style={quotedStyles.meta}>
            From: {from}{'\n'}
            Date: {date}{'\n'}
            Subject: {subject}
          </Text>
          <Text style={quotedStyles.body}>{body}</Text>
        </View>
      )}
    </View>
  );
}

const quotedStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    marginTop: 16,
  },
  dotsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    backgroundColor: '#F3F4F6',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#9CA3AF',
  },
  content: {
    marginTop: 12,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: '#D1D5DB',
  },
  label: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 8,
  },
  meta: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 20,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },
});

// Helper: format recipients (to/cc/bcc) which can be a string, object, or array of objects
function formatRecipients(recipients: any): string {
  if (!recipients) return '';
  if (typeof recipients === 'string') return recipients;
  if (Array.isArray(recipients)) {
    return recipients.map(r => typeof r === 'string' ? r : (r.name || r.email || '')).filter(Boolean).join(', ');
  }
  return recipients.name || recipients.email || '';
}

export default function EmailDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { id } = useLocalSearchParams();

  // Use MailContext
  const {
    currentMessage,
    threadMessages,
    loading: mailLoading,
    isConnected,
    accounts,
    loadMessage,
    loadThread,
    markAsRead,
    toggleStar,
    deleteMessage,
    archiveMessage,
    sendEmail,
    saveDraft: saveDraftToContext,
  } = useMail();

  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [composeModalVisible, setComposeModalVisible] = useState(false);
  const [composeMode, setComposeMode] = useState<'reply' | 'replyAll' | 'forward'>('reply');
  const [showEmailDetails, setShowEmailDetails] = useState(false);
  const [expandedThreadIds, setExpandedThreadIds] = useState<Set<string>>(new Set());

  // Reply/Forward form state
  const [replyTo, setReplyTo] = useState('');
  const [replyCc, setReplyCc] = useState('');
  const [replyBcc, setReplyBcc] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

  useEffect(() => {
    if (id) {
      loadEmailData();
    }
  }, [id]);

  const loadEmailData = async () => {
    if (!id || typeof id !== 'string') return;

    // Check if this is a sample email ID (for fallback)
    const isSampleEmail = id.startsWith('email-');

    try {
      setLoading(true);

      // Load email details from context
      const emailData = await loadMessage(id);

      if (emailData) {
        setEmail(emailData);

        // Mark as read if not already read
        if (!emailData.isRead) {
          markAsRead(id, true);
          setEmail(prev => prev ? { ...prev, isRead: true } : null);
        }

        // Load thread if this message is part of one
        if (emailData.threadId) {
          loadThread(id);
        }
      } else {
        // If context returns null and we have sample data, use it as fallback
        if (isSampleEmail && SAMPLE_EMAIL_DETAILS[id]) {
          setEmail(SAMPLE_EMAIL_DETAILS[id]);
        } else {
          toast.error('Failed to load email');
          router.back();
        }
      }
    } catch (error) {
      console.error('Error loading email:', error);
      // If API fails and we have sample data, use it
      if (isSampleEmail && SAMPLE_EMAIL_DETAILS[id]) {
        setEmail(SAMPLE_EMAIL_DETAILS[id]);
      } else {
        toast.error('Failed to load email');
        router.back();
      }
    } finally {
      setLoading(false);
    }
  };

  // Filter out the current message from thread messages
  const olderThreadMessages = useMemo(() => {
    if (!email || !threadMessages || threadMessages.length <= 1) return [];
    return threadMessages.filter(m => m.id !== email.id);
  }, [email, threadMessages]);

  const toggleThreadExpand = (messageId: string) => {
    setExpandedThreadIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const handleStarToggle = async () => {
    if (!email) return;

    // Toggle star locally immediately for better UX
    const wasStarred = email.isStarred;
    setEmail({ ...email, isStarred: !wasStarred });

    // Toggle star via context
    const success = await toggleStar(email.id);
    if (!success && isConnected) {
      // Revert on error if online
      setEmail(prev => prev ? { ...prev, isStarred: wasStarred } : null);
      toast.error('Failed to update star status');
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
    }
  };

  const handleDelete = async () => {
    if (!email) return;

    const success = await deleteMessage(email.id);
    if (success) {
      toast.success('Email deleted successfully');
      router.back();
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
      router.back();
    } else {
      toast.error('Failed to delete email');
    }
  };

  const handleArchive = async () => {
    if (!email) return;

    const success = await archiveMessage(email.id);
    if (success) {
      toast.success('Email archived successfully');
      router.back();
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
      router.back();
    } else {
      toast.error('Failed to archive email');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const openComposeModal = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!email) return;

    setComposeMode(mode);

    // Populate form fields based on mode
    if (mode === 'reply') {
      setReplyTo(email.fromEmail || getSenderEmail(email.from));
      setReplyCc('');
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`);
      setReplyBody('');
    } else if (mode === 'replyAll') {
      // Reply All: include original sender + all To/Cc recipients, excluding own emails
      const ownEmails = new Set(accounts.map(a => a.email.toLowerCase()));
      const allRecipients = [email.fromEmail || getSenderEmail(email.from)];
      if (email.to) {
        const toStr = formatRecipients(email.to);
        if (toStr) allRecipients.push(...toStr.split(',').map(e => e.trim()));
      }
      const filteredTo = allRecipients.filter(e => e && !ownEmails.has(e.toLowerCase()));
      setReplyTo(filteredTo.join(', '));
      const ccStr = typeof email.cc === 'string' ? email.cc : formatRecipients(email.cc);
      const filteredCc = ccStr ? ccStr.split(',').map(e => e.trim()).filter(e => e && !ownEmails.has(e.toLowerCase())).join(', ') : '';
      setReplyCc(filteredCc);
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`);
      setReplyBody('');
    } else if (mode === 'forward') {
      setReplyTo('');
      setReplyCc('');
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Fwd:') ? email.subject : `Fwd: ${email.subject}`);
      setReplyBody('');
    }

    setComposeModalVisible(true);
  };

  const handleSend = async () => {
    if (!email) return;

    // Validate required fields
    if (!replyTo.trim()) {
      toast.error('Please enter a recipient');
      return;
    }

    if (!replySubject.trim()) {
      toast.warning('Sending message without a subject');
      sendReply();
      return;
    }

    sendReply();
  };

  const sendReply = async () => {
    if (!email) return;

    try {
      setSending(true);

      // Build quoted original message for reply/forward
      const quotedMessage = `\n\n---------- ${composeMode === 'forward' ? 'Forwarded message' : 'Original message'} ---------\nFrom: ${getSenderName(email.from)} (${email.fromEmail || getSenderEmail(email.from)})\nDate: ${email.date} at ${email.time}\nSubject: ${email.subject}\n\n${email.body}`;

      const success = await sendEmail({
        emailAccountId: email.emailAccountId,
        to: replyTo.trim(),
        cc: replyCc.trim() || undefined,
        bcc: replyBcc.trim() || undefined,
        subject: replySubject.trim(),
        body: replyBody + quotedMessage,
        inReplyTo: composeMode !== 'forward' ? ((email as any).messageId || email.inReplyTo || undefined) : undefined,
        threadId: email.threadId,
      });

      if (success) {
        toast.success('Email sent successfully');
        setComposeModalVisible(false);
        // Clear form
        setReplyTo('');
        setReplyCc('');
        setReplyBcc('');
        setReplySubject('');
        setReplyBody('');
      } else if (!isConnected) {
        toast.warning('Email queued for when you\'re back online');
        setComposeModalVisible(false);
        // Clear form
        setReplyTo('');
        setReplyCc('');
        setReplyBcc('');
        setReplySubject('');
        setReplyBody('');
      } else {
        toast.error('Failed to send email');
      }
    } catch (error) {
      console.error('Error sending reply:', error);
      toast.error('Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const saveReplyDraft = async () => {
    if (!email) return;

    try {
      setSavingDraft(true);

      // Build quoted original message for reply/forward
      const quotedMessage = `\n\n---------- ${composeMode === 'forward' ? 'Forwarded message' : 'Original message'} ---------\nFrom: ${getSenderName(email.from)} (${email.fromEmail || getSenderEmail(email.from)})\nDate: ${email.date} at ${email.time}\nSubject: ${email.subject}\n\n${email.body}`;

      const success = await saveDraftToContext({
        emailAccountId: email.emailAccountId,
        to: replyTo.trim() || undefined,
        cc: replyCc.trim() || undefined,
        bcc: replyBcc.trim() || undefined,
        subject: replySubject.trim() || '(No subject)',
        body: (replyBody || '') + quotedMessage,
        inReplyTo: composeMode !== 'forward' ? ((email as any).messageId || email.inReplyTo || undefined) : undefined,
        threadId: email.threadId,
      });

      if (success) {
        toast.success('Draft saved successfully');
        setComposeModalVisible(false);
        // Clear form
        setReplyTo('');
        setReplyCc('');
        setReplyBcc('');
        setReplySubject('');
        setReplyBody('');
      } else if (!isConnected) {
        toast.warning('Draft queued for when you\'re back online');
        setComposeModalVisible(false);
        // Clear form
        setReplyTo('');
        setReplyCc('');
        setReplyBcc('');
        setReplySubject('');
        setReplyBody('');
      } else {
        toast.error('Failed to save draft');
      }
    } catch (error) {
      console.error('Error saving draft:', error);
      toast.error('Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!email) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Email not found</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Fixed header with safe area */}
      <View style={[styles.fixedHeader, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        <View style={styles.subjectRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={26} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <View style={styles.subjectActions}>
            <TouchableOpacity onPress={handleStarToggle} style={styles.actionButton}>
              <Star
                size={21}
                color={email.isStarred ? '#F59E0B' : colors.muted}
                fill={email.isStarred ? '#F59E0B' : 'transparent'}
                strokeWidth={2}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleArchive} style={styles.actionButton}>
              <Archive size={21} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleDelete} style={styles.actionButton}>
              <Trash2 size={21} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Email Header */}
        <View style={styles.emailHeader}>
          <Text style={[styles.subject, { color: colors.text }]}>
            {email.subject}
          </Text>

          <View style={styles.senderSection}>
            <TouchableOpacity
              onPress={() => router.push(`/helpdesk/contact/${encodeURIComponent(email.fromEmail || getSenderEmail(email.from))}` as any)}
              activeOpacity={0.7}
              delayPressIn={0}
            >
              <View style={[styles.avatar, { backgroundColor: '#3B82F620' }]}>
                <Text style={[styles.avatarText, { color: '#3B82F6' }]}>
                  {getSenderName(email.from).charAt(0).toUpperCase()}
                </Text>
              </View>
            </TouchableOpacity>
            <View style={styles.senderInfo}>
              <View style={styles.senderNameRow}>
                <TouchableOpacity
                  onPress={() => router.push(`/helpdesk/contact/${encodeURIComponent(email.fromEmail || getSenderEmail(email.from))}` as any)}
                  activeOpacity={0.7}
                  delayPressIn={0}
                >
                  <Text style={[styles.senderName, { color: colors.text }]}>
                    {getSenderName(email.from)}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.toMeRow}
                  onPress={() => setShowEmailDetails(!showEmailDetails)}
                  activeOpacity={0.6}
                >
                  <Text style={[styles.recipientLabel, { color: colors.muted }]}>
                    {(() => {
                      let toStr = '';
                      if (typeof email.to === 'string') {
                        toStr = email.to;
                      } else if (Array.isArray(email.to)) {
                        toStr = email.to.map((r: any) => typeof r === 'string' ? r : r?.email || r?.address || r?.name || '').join(', ');
                      } else if (email.to && typeof email.to === 'object') {
                        toStr = (email.to as any).email || (email.to as any).address || (email.to as any).name || '';
                      }
                      if (!toStr) return 'to me';
                      const ownEmails = accounts.map(a => (a.emailAddress || (a as any).email || '').toLowerCase());
                      const recipients = toStr.split(/[,;]\s*/).map(r => r.trim().toLowerCase());
                      const allMe = recipients.every(r => ownEmails.some(own => r.includes(own)));
                      return allMe ? 'to me' : `to ${toStr}`;
                    })()}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={styles.dateTime}>
              <Text style={[styles.date, { color: colors.muted }]}>
                {(() => {
                  const d = email.receivedAt ? new Date(email.receivedAt) : null;
                  if (!d || isNaN(d.getTime())) return email.date || '';
                  const now = new Date();
                  const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                  if (isToday) {
                    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                  }
                  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
                })()}
              </Text>
            </View>
          </View>

          {/* Email Details Panel */}
          {showEmailDetails && (
            <View style={[styles.emailDetailsPanel, { borderColor: colors.border }]}>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>From</Text>
                <View style={styles.detailValue}>
                  <Text style={[styles.detailName, { color: colors.text }]}>{getSenderName(email.from)}</Text>
                  <Text style={[styles.detailEmail, { color: colors.muted }]}>{email.fromEmail || getSenderEmail(email.from)}</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>To</Text>
                <Text style={[styles.detailEmail, { color: colors.text }]}>
                  {(() => {
                    if (typeof email.to === 'string') return email.to;
                    if (Array.isArray(email.to)) return email.to.map((r: any) => typeof r === 'string' ? r : r?.email || r?.address || '').join(', ');
                    if (email.to && typeof email.to === 'object') return (email.to as any).email || (email.to as any).address || '';
                    return '';
                  })()}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Date</Text>
                <Text style={[styles.detailEmail, { color: colors.text }]}>
                  {(() => {
                    const d = email.receivedAt ? new Date(email.receivedAt) : null;
                    if (!d || isNaN(d.getTime())) {
                      const d2 = (email as any).receivedDate ? new Date((email as any).receivedDate) : null;
                      if (d2 && !isNaN(d2.getTime())) {
                        return `${d2.getDate()} ${d2.toLocaleDateString('en-US', { month: 'short' })} ${d2.getFullYear()} at ${d2.getHours().toString().padStart(2, '0')}:${d2.getMinutes().toString().padStart(2, '0')}`;
                      }
                      return `${email.date || ''} ${email.time || ''}`.trim();
                    }
                    return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()} at ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                  })()}
                </Text>
              </View>
              <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                <Lock size={16} color={colors.muted} strokeWidth={2} />
                <View style={styles.detailValue}>
                  <Text style={[styles.detailEmail, { color: colors.text }]}>Standard encryption (TLS)</Text>
                </View>
              </View>
            </View>
          )}
        </View>

        {/* Attachments */}
        {email.hasAttachment && email.attachments && email.attachments.length > 0 && (
          <View style={styles.attachmentsSection}>
            <Text style={[styles.attachmentsTitle, { color: colors.text }]}>
              Attachments ({email.attachments.length})
            </Text>
            {email.attachments.map((attachment) => (
              <TouchableOpacity
                key={attachment.id}
                style={[styles.attachmentItem, { backgroundColor: '#F3F4F6' }]}
              >
                <Paperclip size={16} color={colors.text} strokeWidth={2} />
                <Text style={[styles.attachmentName, { color: colors.text }]}>
                  {attachment.filename}
                </Text>
                <Text style={[styles.attachmentSize, { color: colors.muted }]}>
                  {formatFileSize(attachment.size)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Email Body */}
        <View style={styles.bodySection}>
          {(email.bodyHtml || (email as any).htmlBody) ? (
            <EmailHtmlView
              html={email.bodyHtml || (email as any).htmlBody || ''}
              textColor={colors.text}
              fontSize={15}
              lineHeight={1.6}
              initialHeight={300}
              style={styles.webViewBody}
            />
          ) : (
            <Text style={[styles.body, { color: colors.text }]}>
              {email.body || (email as any).textBody || (email as any).content || email.preview || ''}
            </Text>
          )}
        </View>

        {/* Thread Messages */}
        {olderThreadMessages.length > 0 && (
          <View style={threadStyles.container}>
            {/* Divider */}
            <View style={threadStyles.divider}>
              <View style={[threadStyles.dividerLine, { backgroundColor: colors.border }]} />
              <Text style={[threadStyles.dividerText, { color: colors.muted }]}>
                {olderThreadMessages.length} earlier {olderThreadMessages.length === 1 ? 'message' : 'messages'}
              </Text>
              <View style={[threadStyles.dividerLine, { backgroundColor: colors.border }]} />
            </View>

            {/* Thread message cards */}
            {olderThreadMessages.map((threadMsg) => {
              const isExpanded = expandedThreadIds.has(threadMsg.id);
              const senderName = getSenderName(threadMsg.from);
              const msgDate = (() => {
                const d = threadMsg.receivedDate || threadMsg.sentDate;
                if (!d) return threadMsg.date || '';
                const date = new Date(d);
                if (isNaN(date.getTime())) return threadMsg.date || '';
                const now = new Date();
                const isToday = date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
                if (isToday) {
                  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                }
                return `${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'short' })}`;
              })();

              return (
                <View key={threadMsg.id} style={[threadStyles.card, { borderColor: colors.border }]}>
                  <TouchableOpacity
                    style={threadStyles.cardHeader}
                    onPress={() => toggleThreadExpand(threadMsg.id)}
                    activeOpacity={0.7}
                  >
                    <View style={[threadStyles.avatar, { backgroundColor: '#3B82F620' }]}>
                      <Text style={[threadStyles.avatarText, { color: '#3B82F6' }]}>
                        {senderName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={threadStyles.cardInfo}>
                      <Text style={[threadStyles.cardSender, { color: colors.text }]} numberOfLines={1}>
                        {senderName}
                      </Text>
                      {!isExpanded && (
                        <Text style={[threadStyles.cardPreview, { color: colors.muted }]} numberOfLines={1}>
                          {threadMsg.preview || ''}
                        </Text>
                      )}
                    </View>
                    <Text style={[threadStyles.cardDate, { color: colors.muted }]}>{msgDate}</Text>
                    {isExpanded ? (
                      <ChevronUp size={18} color={colors.muted} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={18} color={colors.muted} strokeWidth={2} />
                    )}
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={threadStyles.cardBody}>
                      {threadMsg.htmlBody ? (
                        <EmailHtmlView
                          html={threadMsg.htmlBody}
                          textColor={colors.text}
                          fontSize={14}
                          lineHeight={1.5}
                          initialHeight={200}
                          style={threadStyles.webView}
                        />
                      ) : (
                        <Text style={[threadStyles.bodyText, { color: colors.text }]}>
                          {threadMsg.textBody || threadMsg.preview || ''}
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Action Bar */}
      <View style={[styles.actionBar, {
        backgroundColor: colors.background,
        paddingBottom: insets.bottom + 10
      }]}>
        {(() => {
          // Determine if Reply All makes sense (multiple recipients or has CC)
          const toStr = typeof email.to === 'string' ? email.to : Array.isArray(email.to) ? email.to.map((r: any) => typeof r === 'string' ? r : r?.email || '').join(', ') : '';
          const ccStr = typeof email.cc === 'string' ? email.cc : Array.isArray(email.cc) ? email.cc.map((r: any) => typeof r === 'string' ? r : r?.email || '').join(', ') : '';
          const toCount = toStr ? toStr.split(/[,;]\s*/).filter(Boolean).length : 0;
          const ccCount = ccStr ? ccStr.split(/[,;]\s*/).filter(Boolean).length : 0;
          const hasMultipleRecipients = (toCount + ccCount) > 1;

          return (
            <>
              <TouchableOpacity
                style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
                activeOpacity={0.7}
                onPress={() => openComposeModal('reply')}
              >
                <Reply size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.replyText, { color: colors.text }]}>Reply</Text>
              </TouchableOpacity>
              {hasMultipleRecipients && (
                <TouchableOpacity
                  style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
                  activeOpacity={0.7}
                  onPress={() => openComposeModal('replyAll')}
                >
                  <ReplyAll size={18} color={colors.text} strokeWidth={2} />
                  <Text style={[styles.replyText, { color: colors.text }]}>Reply All</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
                activeOpacity={0.7}
                onPress={() => openComposeModal('forward')}
              >
                <Forward size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.replyText, { color: colors.text }]}>Forward</Text>
              </TouchableOpacity>
            </>
          );
        })()}
      </View>

      {/* Compose Modal */}
      <Modal
        visible={composeModalVisible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => setComposeModalVisible(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <ComposeEmailForm
            title={composeMode === 'reply' ? 'Reply' : composeMode === 'replyAll' ? 'Reply All' : 'Forward'}
            showFromSelector={false}
            closeIcon="back"
            isModal
            onClose={() => setComposeModalVisible(false)}
            onSend={handleSend}
            sending={sending}
            to={replyTo}
            onChangeTo={setReplyTo}
            cc={replyCc}
            onChangeCc={setReplyCc}
            bcc={replyBcc}
            onChangeBcc={setReplyBcc}
            subject={replySubject}
            onChangeSubject={setReplySubject}
            body={replyBody}
            onChangeBody={setReplyBody}
            replyToMessageId={email?.id}
            emailAccountId={email?.emailAccountId}
            quotedMessage={
              <QuotedMessage
                mode={composeMode}
                from={`${getSenderName(email?.from)} (${email?.fromEmail || getSenderEmail(email?.from)})`}
                date={`${email?.date} at ${email?.time}`}
                subject={email?.subject || ''}
                body={email?.body || ''}
              />
            }
          />
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fixedHeader: {
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
    marginLeft: -8,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionButton: {
    padding: 4,
  },
  scrollView: {
    flex: 1,
  },
  emailHeader: {
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 16,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  subject: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 26,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.2)',
  },
  subjectActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  senderSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  avatarText: {
    fontSize: 12,
    fontWeight: '600',
  },
  senderInfo: {
    flex: 1,
  },
  senderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toMeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: -1,
  },
  emailDetailsPanel: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: '#F3F4F6',
    gap: 12,
  },
  detailLabel: {
    fontSize: 13,
    fontWeight: '500',
    width: 40,
    paddingTop: 1,
  },
  detailValue: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  detailName: {
    fontSize: 14,
    fontWeight: '600',
  },
  detailEmail: {
    fontSize: 14,
  },
  senderName: {
    fontSize: 14,
    fontWeight: '600',
  },
  dateTime: {
    alignItems: 'flex-end',
  },
  date: {
    fontSize: 13,
  },
  time: {
    fontSize: 12,
    marginTop: 2,
  },
  recipientLabel: {
    fontSize: 13,
    marginTop: 2,
  },
  attachmentsSection: {
    padding: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  attachmentsTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  attachmentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  attachmentName: {
    flex: 1,
    fontSize: 14,
    marginLeft: 8,
  },
  attachmentSize: {
    fontSize: 12,
  },
  bodySection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  webViewBody: {
    backgroundColor: 'transparent',
    opacity: 0.99,
  },
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 16,
    paddingHorizontal: 16,
    gap: 12,
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
  },
  replyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 8,
    flex: 1,
  },
  replyText: {
    fontSize: 13,
    fontWeight: '500',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
    marginRight: 16,
  },
  composeContent: {
    flex: 1,
  },
  composeField: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  fieldLabel: {
    fontSize: 15,
    fontWeight: '500',
    width: 70,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
  },
  messageField: {
    padding: 16,
    minHeight: 200,
  },
  messageInput: {
    fontSize: 15,
    lineHeight: 22,
    minHeight: 180,
  },
  originalMessage: {
    padding: 16,
    borderTopWidth: 0.5,
    marginTop: 20,
  },
  originalMessageLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  originalMessageText: {
    fontSize: 14,
    lineHeight: 20,
  },
  composeSendBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  sendActions: {
    flexDirection: 'row',
    gap: 12,
  },
  draftButton: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
  draftButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  sendButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

const threadStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: 13,
    fontWeight: '500',
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 12,
    fontWeight: '600',
  },
  cardInfo: {
    flex: 1,
  },
  cardSender: {
    fontSize: 14,
    fontWeight: '600',
  },
  cardPreview: {
    fontSize: 13,
    marginTop: 2,
  },
  cardDate: {
    fontSize: 12,
    marginRight: 4,
  },
  cardBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  webView: {
    backgroundColor: 'transparent',
    opacity: 0.99,
  },
  bodyText: {
    fontSize: 14,
    lineHeight: 20,
  },
});