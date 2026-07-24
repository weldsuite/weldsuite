
import * as React from "react"
import { useRouter } from '@/lib/router'
import { ChevronRight } from "lucide-react"
import { PageLoader } from "@/components/page-loader"
import { Button } from "@weldsuite/ui/components/button"
import { Badge } from "@weldsuite/ui/components/badge"
import { cn } from "@/lib/utils"
import { useIntegrationConnections } from '@/hooks/queries/use-integration-queries'
import { useChannelIntegrations } from '@/hooks/queries/use-helpdesk-integration-queries'
import { useGithubConnection } from '@/hooks/queries/use-github-queries'

interface Integration {
  id: string
  name: string
  description: string
  category: string
  icon: React.ReactNode
  connected: boolean
  configurable: boolean
  href?: string
}

function BrandLogo({ slug, alt, className = 'h-6 w-6' }: { slug: string; alt: string; className?: string }) {
  return (
    <img
      src={`https://api.iconify.design/logos:${slug}.svg`}
      alt={alt}
      className={className}
      loading="lazy"
    />
  )
}

const integrationDefinitions: Omit<Integration, 'connected'>[] = [
  {
    id: 'attio',
    name: 'Attio',
    description: 'Import companies and contacts from Attio CRM. Real-time sync via webhooks.',
    category: 'CRM',
    icon: (
      <img
        src="https://icons.duckduckgo.com/ip3/attio.com.ico"
        alt="Attio"
        className="h-6 w-6 rounded-[4px]"
        loading="lazy"
      />
    ),
    configurable: true,
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'Bidirectional sync with Salesforce CRM. Contacts, leads, opportunities, and more.',
    category: 'CRM',
    icon: <BrandLogo slug="salesforce" alt="Salesforce" />,
    configurable: true,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Sync contacts, companies, deals, and activities with HubSpot CRM.',
    category: 'CRM',
    icon: (
      <img
        src="https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/hubspot-icon.svg"
        alt="HubSpot"
        className="h-[22px] w-[22px]"
        loading="lazy"
      />
    ),
    configurable: true,
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Receive and respond to Discord messages. Custom bot name and avatar per guild.',
    category: 'Support',
    icon: (
      <img
        src="https://www.svgrepo.com/show/349338/discord.svg"
        alt="Discord"
        className="h-[26px] w-[26px]"
        loading="lazy"
      />
    ),
    configurable: true,
    href: '/settings/integrations/discord',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Receive and respond to Slack messages. Auto-threaded conversations in your support channels.',
    category: 'Support',
    icon: (
      <img
        src="https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg"
        alt="Slack"
        className="h-[20px] w-[20px]"
        loading="lazy"
      />
    ),
    configurable: true,
    href: '/settings/integrations/slack',
  },
  {
    id: 'mcp_servers',
    name: 'MCP Servers',
    description: 'Connect external tool servers (MCP) to give AI agents access to custom tools and APIs.',
    category: 'AI',
    icon: (
      <img
        src="https://upload.wikimedia.org/wikipedia/commons/f/fe/Model_Context_Protocol_logo.svg"
        alt="MCP Servers"
        className="h-[21px] w-[21px]"
        loading="lazy"
      />
    ),
    configurable: true,
    href: '/settings/integrations/mcp-servers',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Sync events and calendars from Google Calendar. Two-way sync keeps everything up to date.',
    category: 'Calendar',
    icon: <BrandLogo slug="google-calendar" alt="Google Calendar" className="h-5 w-5" />,
    configurable: true,
    href: '/settings/integrations/google-calendar',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Two-way sync between GitHub Issues and your WeldFlow tasks. Link repositories to projects.',
    category: 'Developer Tools',
    icon: (
      <img
        src="https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg"
        alt="GitHub"
        className="h-6 w-6"
        loading="lazy"
      />
    ),
    configurable: true,
    href: '/settings/integrations/github',
  },
]

const CATEGORY_ORDER = ['CRM', 'Support', 'Calendar', 'AI', 'Developer Tools']

export function IntegrationsSection() {
  const router = useRouter()
  const [hoveredIntegration, setHoveredIntegration] = React.useState<string | null>(null)

  const { data: integrationConnectionsResult, isLoading: connectionsLoading } = useIntegrationConnections()
  const { data: channelIntegrationsResult, isLoading: channelLoading } = useChannelIntegrations()
  const { data: githubConnectionResult } = useGithubConnection()

  const integrations = React.useMemo(() => {
    const crmConnections = integrationConnectionsResult?.data ?? []
    const isProviderConnected = (provider: string) =>
      crmConnections.some(c => c.provider === provider && c.status !== 'inactive')
    const mcpCount = crmConnections.filter(c => c.provider === 'mcp_server' && c.status === 'active').length

    // Cast through `unknown`, not the documented `Helpdesk.Api.ChannelIntegration`
    // shape: that type references an undefined `ChannelIntegrationStatus`
    // (lib/api/types/apps/helpdesk.types.ts), so trusting it here would just
    // trade one `any` for a broken type.
    const channelIntegrations = (
      (channelIntegrationsResult?.data as unknown as { integrations?: Array<{ provider: string; status: string }> })
        ?.integrations ?? []
    )
    const discordConnected = channelIntegrations.some(c => c.provider === 'discord' && c.status === 'connected')
    const slackConnected = channelIntegrations.some(c => c.provider === 'slack' && c.status === 'connected')
    const githubConnection = githubConnectionResult?.data
    const githubConnected = !!githubConnection && githubConnection.status === 'active'

    return integrationDefinitions.map(def => {
      let connected = false
      if (def.id === 'discord') connected = discordConnected
      else if (def.id === 'slack') connected = slackConnected
      else if (def.id === 'mcp_servers') connected = mcpCount > 0
      else if (def.id === 'github') connected = githubConnected
      else if (['attio', 'salesforce', 'hubspot', 'google_calendar'].includes(def.id)) connected = isProviderConnected(def.id)
      return { ...def, connected }
    })
  }, [integrationConnectionsResult, channelIntegrationsResult, githubConnectionResult])

  const { integrationsByCategory, sortedCategories } = React.useMemo(() => {
    const grouped: Record<string, Integration[]> = {}
    integrations.forEach((integration) => {
      if (!grouped[integration.category]) grouped[integration.category] = []
      grouped[integration.category].push(integration)
    })
    const sorted = CATEGORY_ORDER.filter(cat => grouped[cat])
    Object.keys(grouped).forEach(cat => {
      if (!sorted.includes(cat)) sorted.push(cat)
    })
    return { integrationsByCategory: grouped, sortedCategories: sorted }
  }, [integrations])

  const scrollToCategory = (category: string) => {
    const element = document.getElementById(`category-${category.replace(/\s+/g, '-').toLowerCase()}`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  if (connectionsLoading || channelLoading) {
    return <PageLoader fullScreen={false} />
  }

  return (
    <div className="flex justify-center min-h-full relative">
      <div className="w-full max-w-[1150px] flex relative">
          {/* Categories Section */}
          <div className="hidden md:flex md:w-60 md:shrink-0 py-6 md:pl-8 border-r border-border">
            <div className="sticky top-6 w-full">
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
                CATEGORIES
              </h2>
              <div className="flex flex-col gap-1">
                {sortedCategories.map((category) => (
                  <Button
                    key={category}
                    variant="ghost"
                    onClick={() => scrollToCategory(category)}
                    className={cn(
                      'py-2 px-3 text-left text-sm border-none rounded-lg cursor-pointer transition-all -ml-3 mr-3',
                      'hover:bg-accent hover:text-foreground',
                      'text-muted-foreground font-normal'
                    )}
                  >
                    {category}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Integrations Content */}
          <div className="flex-1 p-4 md:p-6 md:pl-8">
            {sortedCategories.map((category, index) => (
              <div
                key={category}
                id={`category-${category.replace(/\s+/g, '-').toLowerCase()}`}
                className="scroll-mt-6"
              >
                {index > 0 && (
                  <div className="border-t border-dashed border-border my-8" />
                )}
                <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
                  {category}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {integrationsByCategory[category].map((integration) => (
                    <div
                      key={integration.id}
                      className="bg-card border border-border rounded-xl p-4 cursor-pointer transition-all relative hover:bg-accent/50 hover:border-border/80"
                      onMouseEnter={() => setHoveredIntegration(integration.id)}
                      onMouseLeave={() => setHoveredIntegration(null)}
                      onClick={() => router.push(integration.href || `/settings/integrations/${integration.id}`)}
                    >
                      {integration.connected && hoveredIntegration !== integration.id && (
                        <Badge className="absolute top-3 right-3 rounded bg-blue-100 text-blue-600 border-transparent dark:bg-blue-950 dark:text-blue-400">
                          Connected
                        </Badge>
                      )}
                      {hoveredIntegration === integration.id && (
                        <ChevronRight className="absolute top-5 right-4 z-10 h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="flex flex-col gap-3">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-[0.625rem] bg-white dark:bg-background border border-gray-200 dark:border-border flex items-center justify-center shrink-0">
                            {integration.icon}
                          </div>
                          <div className="relative top-px">
                            <div className="flex items-center gap-1.5 mb-px">
                              <h3 className="text-[0.9375rem] font-semibold text-foreground m-0">
                                {integration.name}
                              </h3>
                            </div>
                            <p className="text-xs text-muted-foreground m-0">
                              {integration.category}
                            </p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground m-0 leading-[1.4] line-clamp-2">
                          {integration.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="pb-8" />
          </div>
        </div>
      </div>
  )
}
