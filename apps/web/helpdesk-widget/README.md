# Helpdesk Widget

Real-time customer support widget with SignalR integration for instant messaging.

## Features

- **Real-time Communication**: Built with SignalR for instant bi-directional messaging
- **Embeddable Widget**: Easy integration with any website using a simple script tag
- **Typing Indicators**: See when agents or customers are typing
- **Agent Status**: Display agent availability (online, away, busy, offline)
- **Message Attachments**: Support for file uploads and sharing
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **Customizable**: Configure position, colors, and behavior
- **Auto-reconnect**: Handles network interruptions gracefully

## Installation

### Quick Start (Embed on any website)

Add this script to your website's HTML:

```html
<!-- Configure the widget -->
<script>
  window.helpdeskConfig = {
    apiUrl: 'http://localhost:3100',
    position: 'bottom-right', // bottom-right, bottom-left, top-right, top-left
    primaryColor: '#3b82f6',
    theme: 'light', // light or dark
    customerName: 'John Doe', // Optional
    customerEmail: 'john@example.com' // Optional
  };
</script>

<!-- Load the widget -->
<script src="http://localhost:3100/embed.js"></script>
```

### Development

1. **Install Dependencies**

```bash
cd apps/web/helpdesk-widget
pnpm install
```

2. **Configure Environment**

Copy `.env.example` to `.env.local` and update:

```bash
cp .env.example .env.local
```

```env
# SignalR Hub URL (your backend helpdesk service)
NEXT_PUBLIC_SIGNALR_HUB_URL=http://localhost:5000/hubs/helpdesk

# Widget API Base URL
NEXT_PUBLIC_API_BASE_URL=http://localhost:3100

# Backend API URL (for creating conversations)
BACKEND_API_URL=http://localhost:5000
```

3. **Run Development Server**

```bash
pnpm dev
```

The widget will be available at `http://localhost:3100`

4. **Build for Production**

```bash
pnpm build
pnpm start
```

## Usage

### JavaScript API

The widget provides a JavaScript API for programmatic control:

```javascript
// Show the widget
window.HelpdeskWidget.show();

// Hide the widget
window.HelpdeskWidget.hide();

// Update configuration
window.HelpdeskWidget.updateConfig({
  primaryColor: '#ff0000',
  position: 'bottom-left'
});

// Destroy the widget
window.HelpdeskWidget.destroy();
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiUrl` | string | `http://localhost:3100` | Widget API base URL |
| `position` | string | `bottom-right` | Widget position on screen |
| `primaryColor` | string | `#3b82f6` | Primary brand color |
| `theme` | string | `light` | Widget theme (light/dark) |
| `conversationId` | string | - | Existing conversation ID |
| `customerName` | string | - | Customer name (optional) |
| `customerEmail` | string | - | Customer email (optional) |

## Backend Requirements

The widget requires a SignalR backend hub with the following methods:

### Server -> Client Events

- `ReceiveMessage(message)` - New message received
- `UserTyping(indicator)` - User is typing
- `AgentJoined(agent)` - Agent joined conversation
- `AgentLeft(agentId)` - Agent left conversation
- `AgentStatusChanged(agent)` - Agent status updated
- `ConversationClosed(conversationId)` - Conversation closed
- `ConversationAssigned(conversationId, agent)` - Conversation assigned
- `MessageRead(conversationId, messageIds)` - Messages marked as read

### Client -> Server Methods

- `SendMessage(conversationId, content, attachments)` - Send a message
- `StartTyping(conversationId)` - Start typing indicator
- `StopTyping(conversationId)` - Stop typing indicator
- `JoinConversation(conversationId)` - Join a conversation
- `LeaveConversation(conversationId)` - Leave a conversation
- `MarkAsRead(conversationId, messageIds)` - Mark messages as read
- `RequestAgent(conversationId, message)` - Request an agent
- `CloseConversation(conversationId)` - Close conversation

## Architecture

```
apps/web/helpdesk-widget/
├── app/
│   ├── api/              # API routes
│   │   ├── conversations/ # Conversation management
│   │   └── health/       # Health check
│   ├── widget/           # Widget iframe page
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Landing/docs page
├── components/
│   └── widget/           # Widget components
│       ├── chat-widget.tsx
│       ├── chat-message.tsx
│       ├── typing-indicator.tsx
│       ├── agent-status.tsx
│       └── widget-launcher.tsx
├── lib/
│   ├── services/         # Services
│   │   └── signalr-service.ts
│   ├── types/            # TypeScript types
│   │   └── signalr.types.ts
│   └── utils/            # Utilities
│       └── cn.ts
└── public/
    └── embed.js          # Embeddable script

```

## Technology Stack

- **Next.js 15** - React framework with App Router
- **React 19** - UI library
- **SignalR** (@microsoft/signalr) - Real-time communication
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Lucide React** - Icons

## Development Tips

### Testing SignalR Connection

1. Make sure your backend SignalR hub is running
2. Check the browser console for connection logs
3. Test the connection with:

```javascript
// Open browser console on widget page
const service = window.HelpdeskWidget.signalRService;
console.log('Connection state:', service.getConnectionState());
```

### Debugging

Enable verbose logging in SignalR service (signalr-service.ts):

```typescript
.configureLogging(signalR.LogLevel.Debug)
```

### CORS Configuration

Ensure your backend allows CORS requests from the widget domain. The widget includes CORS headers in `next.config.ts`.

## Deployment

### Production Build

```bash
pnpm build
```

### Environment Variables

Set these in your production environment:

- `NEXT_PUBLIC_SIGNALR_HUB_URL` - Your SignalR hub URL
- `NEXT_PUBLIC_API_BASE_URL` - Widget API URL
- `BACKEND_API_URL` - Backend API URL

### CDN Deployment

The `embed.js` file can be served from a CDN:

```html
<script src="https://cdn.yoursite.com/helpdesk/embed.js"></script>
```

## License

Private - Part of WeldSuite monorepo
