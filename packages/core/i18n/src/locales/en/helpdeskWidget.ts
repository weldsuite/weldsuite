/**
 * Chat widget preview (WeldDesk > Chat widget): the mock widget rendered in the editor.
 */
export const helpdeskWidget = {
  nav: {
    home: 'Home',
    chat: 'Chat',
    help: 'Help',
    status: 'Status',
    changelog: 'Changelog',
    news: 'News',
    book: 'Book',
    announce: 'Announce',
    events: 'Events',
    track: 'Track',
  },
  common: {
    close: 'Close',
    back: 'Back',
  },
  announcements: {
    title: 'Announcements',
    highPriority: 'High Priority',
    items: {
      maintenance: {
        title: 'Scheduled Maintenance',
        description: 'Our platform will undergo scheduled maintenance on December 20th from 2:00 AM to 4:00 AM UTC. During this time, some services may be temporarily unavailable.',
        date: 'December 15, 2024',
      },
      featureLaunch: {
        title: 'New Feature Launch: Advanced Analytics',
        description: "We're excited to announce the launch of our Advanced Analytics dashboard. Get deeper insights into your data with customizable reports and real-time metrics.",
        date: 'December 12, 2024',
      },
      securityUpdate: {
        title: 'Security Update Completed',
        description: "We've successfully completed our latest security update. All systems are now running with enhanced encryption and improved authentication protocols.",
        date: 'December 8, 2024',
      },
      holidayHours: {
        title: 'Holiday Support Hours',
        description: "Please note that our support team will be operating on reduced hours from December 24th to January 2nd. We'll return to normal hours on January 3rd.",
        date: 'December 5, 2024',
      },
    },
  },
  appointments: {
    title: 'Book Appointment',
    appointmentType: 'Appointment Type',
    videoCall: 'Video Call',
    phoneCall: 'Phone Call',
    selectDate: 'Select Date',
    selectTime: 'Select Time',
    weekdaysShort: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    name: 'Name',
    namePlaceholder: 'John Smith',
    email: 'Email',
    notesOptional: 'Notes (optional)',
    notesPlaceholder: 'What would you like to discuss?',
    bookAppointment: 'Book Appointment',
    booked: 'Appointment Booked!',
    scheduledFor: 'Your {type} is scheduled for:',
    typeVideo: 'video call',
    typePhone: 'phone call',
    confirmationNotice: "You'll receive a confirmation email shortly",
  },
  article: {
    sections: {
      overview: 'Overview',
      gettingStarted: 'Getting Started',
      keyFeatures: 'Key Features',
      advancedUsage: 'Advanced Usage',
      troubleshooting: 'Troubleshooting',
    },
    minimize: 'Minimize',
    expand: 'Expand',
    subtitle: 'Learn about each of our features for customer service.',
    writtenBy: 'Written by {author}',
    updated: 'Updated {when}',
    defaultUpdatedAt: 'over 4 months ago',
    tableOfContents: 'Table of contents',
    body: {
      heading: 'Customer Service Suite',
      intro: 'The Customer Service Suite combines the #1 AI agent for customer support with a next-gen Helpdesk—built on a single platform that maximizes team efficiency and delivers superior service.',
      screenshot: 'Product Screenshot',
      aiAgentHeading: 'AI Agent features',
      aiAgentText: 'Our AI is the highest-performing AI agent in customer service. It resolves complex issues with safe, accurate, conversational answers—no scripted responses.',
      benefitsHeading: 'Key Benefits',
      benefits: {
        instant: 'Instant resolution for common inquiries',
        availability: '24/7 availability for customer support',
        handoff: 'Seamless handoff to human agents when needed',
        learning: 'Continuous learning from interactions',
      },
      gettingStartedHeading: 'Getting Started',
      gettingStartedText: 'To begin using our customer service features, follow these simple steps:',
      steps: {
        connect: 'Connect your communication channels (email, chat, social)',
        configure: 'Configure your AI agent settings and knowledge base',
        roles: 'Set up team roles and permissions',
        customize: 'Customize your chat widget appearance',
      },
    },
  },
  changelog: {
    title: 'Changelog',
    tags: {
      newFeature: 'New feature',
      automation: 'Automation',
      security: 'Security',
      update: 'Update',
    },
    items: {
      trainFin: {
        title: 'Train Fin to detect key attributes in every conversation',
        description: 'Fin can now automatically detect the attributes you define—like issue type,...',
        date: 'December 13, 2024',
      },
      smartAutomation: {
        title: 'Introducing Smart Automation workflows',
        description: 'Set up complex multi-step automations with our visual builder and AI-suggested optimizations.',
        date: 'December 5, 2024',
      },
      security: {
        title: 'Enhanced Security & Compliance features',
        description: 'Enterprise-grade security with SOC 2 Type II compliance and advanced encryption.',
        date: 'November 28, 2024',
      },
    },
  },
  events: {
    title: 'Upcoming Events',
    categories: {
      webinar: 'webinar',
      workshop: 'workshop',
      conference: 'conference',
      meetup: 'meetup',
    },
    online: 'Online',
    attendees: '{count} / {max} attendees',
    spotsLeft: '{count} spots left!',
    registered: 'Registered',
    registerNow: 'Register Now',
    items: {
      roadmapWebinar: {
        title: 'Product Roadmap Webinar Q1 2025',
        description: "Join us for an exclusive look at what's coming in Q1 2025. Learn about new features, improvements, and get your questions answered live.",
        date: 'January 15, 2025',
        time: '10:00 AM - 11:30 AM PST',
      },
      analyticsWorkshop: {
        title: 'Advanced Analytics Workshop',
        description: 'Deep dive into our analytics platform. Learn best practices, advanced techniques, and how to build custom dashboards.',
        date: 'January 22, 2025',
        time: '2:00 PM - 4:00 PM PST',
      },
      successSummit: {
        title: 'Customer Success Summit 2025',
        description: 'Network with fellow users, share success stories, and learn from industry experts at our annual summit.',
        date: 'February 5-6, 2025',
        time: '9:00 AM - 5:00 PM PST',
      },
      nycMeetup: {
        title: 'Local User Meetup - NYC',
        description: 'Connect with other users in the New York area. Casual networking, pizza, and product discussions.',
        date: 'January 30, 2025',
        time: '6:00 PM - 8:00 PM EST',
      },
    },
  },
  chat: {
    escalation: {
      humanRequested: 'Customer requested human assistance',
      aiCannotHelp: 'AI determined it cannot help',
      aiDisabled: 'AI assistant is not enabled. Would you like to speak with a human agent?',
      connectionError: 'Connection error - would you like to speak with a human agent?',
      requestedHuman: 'Customer requested to speak with a human agent',
      forwarded: 'Your request has been forwarded to our support team. A human agent will assist you shortly.',
    },
    talkToHumanTitle: 'Talk to a human agent',
    talkToHuman: 'Talk to Human',
    connectToHuman: 'Connect to human',
    continueWithAi: 'Continue with AI',
    createTicketTitle: 'Create a support ticket?',
    createTicketDescription: 'This will create a ticket so our team can investigate and follow up with you.',
    createTicket: 'Create ticket',
    notNow: 'Not now',
    sendMessage: 'Send message',
    messagePlaceholder: 'Type a message...',
    launcherAlt: 'Chat',
  },
  faq: {
    title: 'Help',
    searchPlaceholder: 'Search for help...',
    noResults: 'No collections found matching your search',
    articleCount: '{count} articles',
    articlePlaceholder: {
      intro: 'This is where the full article content would appear. The article provides detailed information about {title}.',
      details: 'You can include step-by-step instructions, screenshots, videos, and other helpful resources to guide users through the process.',
      help: 'If you need additional help, feel free to start a conversation with our support team.',
    },
    collections: {
      gettingStarted: {
        title: 'Getting Started',
        description: 'Everything you need to know to get started with our platform.',
        articles: {
          article1: {
            title: 'Creating your first project',
            description: 'Learn how to set up and configure your first project.',
          },
          article2: {
            title: 'Inviting team members',
            description: 'Add collaborators to your workspace.',
          },
          article3: {
            title: 'Understanding the dashboard',
            description: 'Navigate and customize your main dashboard.',
          },
          article4: {
            title: 'Setting up notifications',
            description: 'Configure alerts and notification preferences.',
          },
        },
      },
      accountBilling: {
        title: 'Account & Billing',
        description: 'Manage your account settings, subscriptions, and payment methods.',
        articles: {
          article1: {
            title: 'Updating your profile',
            description: 'Change your name, email, and profile picture.',
          },
          article2: {
            title: 'Managing subscriptions',
            description: 'Upgrade, downgrade, or cancel your plan.',
          },
          article3: {
            title: 'Payment methods',
            description: 'Add or update your payment information.',
          },
          article4: {
            title: 'Viewing invoices',
            description: 'Access and download your billing history.',
          },
        },
      },
      featuresTools: {
        title: 'Features & Tools',
        description: 'Learn how to use all the features and tools available to you.',
        articles: {
          article1: {
            title: 'Using the chat widget',
            description: 'Configure and customize your chat widget.',
          },
          article2: {
            title: 'Setting up automations',
            description: 'Create automated workflows and responses.',
          },
          article3: {
            title: 'Analytics and reporting',
            description: 'Track performance and generate reports.',
          },
          article4: {
            title: 'Knowledge base setup',
            description: 'Create and organize help articles.',
          },
        },
      },
      integrations: {
        title: 'Integrations',
        description: 'Connect with third-party tools and services.',
        articles: {
          article1: {
            title: 'Slack integration',
            description: 'Connect your workspace to Slack.',
          },
          article2: {
            title: 'Zapier workflows',
            description: 'Automate tasks with Zapier.',
          },
          article3: {
            title: 'CRM connections',
            description: 'Sync with Salesforce, HubSpot, and more.',
          },
          article4: {
            title: 'API documentation',
            description: 'Build custom integrations with our API.',
          },
        },
      },
      troubleshooting: {
        title: 'Troubleshooting',
        description: 'Find solutions to common issues and problems.',
        articles: {
          article1: {
            title: 'Connection issues',
            description: 'Resolve connectivity and sync problems.',
          },
          article2: {
            title: 'Login problems',
            description: 'Fix authentication and access issues.',
          },
          article3: {
            title: 'Performance optimization',
            description: 'Speed up your workspace.',
          },
          article4: {
            title: 'Error messages explained',
            description: 'Understand and resolve common errors.',
          },
        },
      },
    },
  },
  messages: {
    title: 'Messages',
    emptyTitle: 'No conversations yet',
    emptyDescription: 'Start a new conversation with our support team',
    newConversation: 'New conversation',
    noResultsTitle: 'No results found',
    noResultsDescription: 'Try searching with different keywords',
    searchPlaceholder: 'Search conversations...',
    sendNewMessage: 'Send new message',
    samples: {
      first: {
        title: 'Third',
        preview: 'Hi 👋 How can I help you?',
        time: '6 days ago',
      },
      second: {
        title: 'Support',
        preview: 'Your issue has been resolved. Please check and confirm.',
        time: '2 weeks ago',
      },
      third: {
        title: 'Billing',
        preview: 'Your invoice for this month is ready for review.',
        time: '1 month ago',
      },
    },
  },
  news: {
    title: 'News',
    items: {
      funding: {
        title: 'We Raised $50M in Series B Funding',
        description: "We're thrilled to announce our Series B funding round led by top-tier investors.",
      },
      enterprise: {
        title: 'Introducing Our New Enterprise Plan',
        description: 'The Enterprise Plan includes advanced security features, dedicated support, and custom integrations.',
      },
      g2: {
        title: 'Recognized as Leader in G2 Grid Report',
        description: "We're honored to be named a Leader in G2's Winter 2024 Grid Report for Customer Service Software.",
      },
    },
  },
  parcelTracking: {
    goBack: 'Go back',
    trackingDetails: 'Tracking Details',
    trackParcel: 'Track Parcel',
    tracking: 'Tracking...',
    companyLogoAlt: 'Company logo',
    trackingNumberPlaceholder: 'Enter tracking number...',
    enterTrackingNumber: 'Please enter a tracking number',
    estimatedDelivery: 'Est. Delivery: {date}',
    trackingHistory: 'Tracking History',
    viewFullDetails: 'View Full Details',
    statuses: {
      delivered: 'Delivered',
      in_transit: 'In Transit',
      pending: 'Pending',
      exception: 'Exception',
      unknown: 'Unknown',
    },
    mock: {
      locations: {
        amsterdam: 'Amsterdam Distribution Center',
        rotterdam: 'Rotterdam Hub',
        origin: 'Origin Warehouse',
      },
      eventStatuses: {
        departed: 'Departed',
        received: 'Received',
        pickedUp: 'Picked Up',
      },
      events: {
        processing: 'Package is being processed at distribution center',
        departed: 'Package has departed from facility',
        received: 'Package received at sorting facility',
        pickedUp: 'Package picked up from sender',
      },
    },
  },
  status: {
    title: 'System Status',
    allOperational: 'All systems operational',
    systemStatusLabel: 'System status',
    systemStatus: 'System status',
    previousPeriod: 'Previous period',
    nextPeriod: 'Next period',
    serviceOperational: '{name} operational',
    uptime: '{percentage} uptime',
    levels: {
      operational: 'Operational',
      minor: 'Minor degradation',
      moderate: 'Partial degradation',
      major: 'Major outage',
    },
    services: {
      cloud: 'Attio Cloud',
      webClient: 'Attio Web Client',
      backgroundTasks: 'Background Tasks',
      cloudStorage: 'Attio Cloud Storage',
      helpdesk: 'Customer Helpdesk',
    },
  },
  home: {
    logoAlt: 'Logo',
    heading: 'How can we help?',
    searchPlaceholder: 'Search for help...',
    sendMessageTitle: 'Send us a message',
    sendMessageDescription: "We'll reply as soon as we can",
    helpCenterTitle: 'Help center',
    helpCenterDescription: 'Find answers in our articles',
    trackOrderTitle: 'Track order',
    trackOrderDescription: 'Check your delivery status',
    updates: 'Updates',
    updatesTab: 'Updates',
    updateItems: {
      aiFeatures: 'New AI-powered features',
      aiFeaturesDate: 'Dec 5',
      performance: 'Performance improvements',
      performanceDate: 'Nov 28',
    },
    quickLinks: 'Quick links',
    quickLinkItems: {
      gettingStarted: 'Getting started',
      accountSettings: 'Account settings',
      billing: 'Billing & plans',
    },
  },
};
