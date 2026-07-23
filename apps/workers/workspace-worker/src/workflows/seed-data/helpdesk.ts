/**
 * Helpdesk sample data seeder.
 *
 * Seeds: departments, article folders, articles, canned responses.
 * Note: Helpdesk workflows are seeded separately in default-helpdesk-workflows.ts.
 */

import { helpdeskDepartments } from '@weldsuite/db/schema/helpdesk-departments';
import { helpdeskArticleFolders } from '@weldsuite/db/schema/helpdesk-article-folders';
import { helpdeskArticles } from '@weldsuite/db/schema/helpdesk-articles';
import { helpdeskCannedResponses } from '@weldsuite/db/schema/helpdesk-canned-responses';
import type { DrizzleDb, SeedContext } from './types';

export async function seedHelpdeskData(db: DrizzleDb, ctx: SeedContext): Promise<void> {
  // Idempotency: skip if departments already exist
  const existing = await db.select({ id: helpdeskDepartments.id }).from(helpdeskDepartments).limit(1);
  if (existing.length > 0) {
    console.log('[Seed:Helpdesk] Departments already exist, skipping');
    return;
  }

  const { generateId, userId, userName } = ctx;

  // ── Departments ────────────────────────────────────────────────────────
  await db.insert(helpdeskDepartments).values([
    {
      id: generateId('dept'),
      name: 'General Support',
      description: 'General customer inquiries, account questions, and onboarding assistance.',
      isActive: true,
      defaultPriority: 'medium',
      sortOrder: 0,
      replyTime: 'A few hours',
    },
    {
      id: generateId('dept'),
      name: 'Technical Support',
      description: 'Technical issues, bug reports, and integration troubleshooting.',
      isActive: true,
      defaultPriority: 'high',
      sortOrder: 1,
      replyTime: 'A few minutes',
    },
  ]);

  // ── Article Folders ────────────────────────────────────────────────────
  const gettingStartedFolderId = generateId('afld');
  const faqFolderId = generateId('afld');

  await db.insert(helpdeskArticleFolders).values([
    {
      id: gettingStartedFolderId,
      name: 'Getting Started',
      slug: 'getting-started',
      description: 'Learn the basics and get up to speed quickly.',
      level: 0,
      sortOrder: 0,
      icon: 'BookOpen',
      articleCount: 1,
    },
    {
      id: faqFolderId,
      name: 'FAQ',
      slug: 'faq',
      description: 'Frequently asked questions and quick answers.',
      level: 0,
      sortOrder: 1,
      icon: 'HelpCircle',
      articleCount: 1,
    },
  ]);

  // ── Articles ───────────────────────────────────────────────────────────
  const now = new Date();
  const authorName = userName || 'Support Team';

  await db.insert(helpdeskArticles).values([
    {
      id: generateId('art'),
      title: 'Welcome to Our Help Center',
      slug: 'welcome-to-help-center',
      content: `# Welcome to Our Help Center

We're glad you're here! This help center is your go-to resource for getting the most out of our platform.

## What You'll Find Here

- **Getting Started guides** to help you set up your workspace
- **How-to articles** for specific features and workflows
- **FAQ section** for quick answers to common questions

## Need More Help?

If you can't find what you're looking for, don't hesitate to reach out to our support team. You can:

- Start a live chat using the widget in the bottom right corner
- Submit a support ticket from the contact page
- Email us directly at your support address

We're here to help you succeed!`,
      excerpt: 'Get started with our help center and learn where to find answers.',
      authorId: userId,
      authorName,
      categoryId: gettingStartedFolderId,
      categoryName: 'Getting Started',
      status: 'published',
      visibility: 'public',
      publishedAt: now,
      isDraft: false,
      readTime: 2,
      difficulty: 'beginner',
      keywords: ['welcome', 'getting started', 'help', 'support'],
      tags: ['getting-started'],
    },
    {
      id: generateId('art'),
      title: 'How to Contact Support',
      slug: 'how-to-contact-support',
      content: `# How to Contact Support

There are several ways to get in touch with our support team.

## Live Chat

The fastest way to reach us is through live chat. Click the chat widget in the bottom right corner of any page to start a conversation.

**Availability:** Monday - Friday, 9:00 AM - 5:00 PM CET

## Support Tickets

For non-urgent inquiries, submit a support ticket. This is ideal for:

- Detailed technical issues that need investigation
- Feature requests and feedback
- Account or billing questions

## Response Times

| Priority | Response Time |
|----------|---------------|
| Urgent   | Within 1 hour |
| High     | Within 4 hours |
| Medium   | Within 8 hours |
| Low      | Within 24 hours |

We strive to resolve all issues as quickly as possible and will keep you updated throughout the process.`,
      excerpt: 'Learn about the different ways to reach our support team.',
      authorId: userId,
      authorName,
      categoryId: faqFolderId,
      categoryName: 'FAQ',
      status: 'published',
      visibility: 'public',
      publishedAt: now,
      isDraft: false,
      readTime: 2,
      difficulty: 'beginner',
      keywords: ['contact', 'support', 'chat', 'ticket', 'help'],
      tags: ['faq', 'support'],
    },
  ]);

  // ── Canned Responses ───────────────────────────────────────────────────
  await db.insert(helpdeskCannedResponses).values([
    {
      id: generateId('cr'),
      name: 'Greeting',
      shortcut: '/greet',
      content: "Hello! Thank you for reaching out. How can I help you today?",
      category: 'General',
      scope: 'global',
      isActive: true,
      keywords: ['hello', 'hi', 'greeting', 'welcome'],
    },
    {
      id: generateId('cr'),
      name: 'Closing',
      shortcut: '/close',
      content: "Thank you for contacting us! If you have any other questions, don't hesitate to reach out. Have a great day!",
      category: 'General',
      scope: 'global',
      isActive: true,
      keywords: ['bye', 'close', 'goodbye', 'thanks'],
    },
    {
      id: generateId('cr'),
      name: 'Escalation',
      shortcut: '/escalate',
      content: "I'm going to involve a specialist from our technical team to help resolve this for you. They'll review the details and follow up shortly. Thank you for your patience!",
      category: 'General',
      scope: 'global',
      isActive: true,
      keywords: ['escalate', 'specialist', 'technical', 'transfer'],
    },
  ]);

  console.log('[Seed:Helpdesk] Seeded 2 departments, 2 article folders, 2 articles, 3 canned responses');
}
