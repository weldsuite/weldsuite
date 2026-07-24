"use client"

import * as React from "react"
import {
  Video,
  MessageCircle,
  Activity,
  DollarSign,
  Settings,
  Search,
  CheckCircle,
} from "lucide-react"
import { Button } from "../button"
import { Switch } from "../switch"
import { Input } from "../input"
import { Badge } from "../badge"
import { Card, CardContent, CardHeader, CardTitle } from "../card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"

export function IntegrationsSection() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold">Integrations</h3>
          <p className="text-sm text-muted-foreground">Connect your favorite tools and services</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search integrations..." className="pl-10 w-64" />
          </div>
        </div>
      </div>

      <Tabs defaultValue="all" className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="connected">Connected</TabsTrigger>
          <TabsTrigger value="communication">Communication</TabsTrigger>
          <TabsTrigger value="shipping">Shipping</TabsTrigger>
          <TabsTrigger value="accounting">Accounting</TabsTrigger>
          <TabsTrigger value="ecommerce">E-Commerce</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {/* Google Meet */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-950 flex items-center justify-center">
                      <Video className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Google Meet</CardTitle>
                      <Badge variant="secondary" className="mt-1">Communication</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Schedule and join video meetings directly from your workspace
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Microsoft Teams */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-950 flex items-center justify-center">
                      <MessageCircle className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Microsoft Teams</CardTitle>
                      <Badge variant="secondary" className="mt-1">Communication</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Collaborate with your team through chat, calls, and meetings
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* DHL */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">DHL</CardTitle>
                      <Badge variant="secondary" className="mt-1">Shipping</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Manage shipments and track packages with DHL integration
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* UPS */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">UPS</CardTitle>
                      <Badge variant="secondary" className="mt-1">Shipping</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Ship packages and track deliveries with UPS worldwide
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Exact Online */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-red-100 dark:bg-red-950 flex items-center justify-center">
                      <DollarSign className="h-5 w-5 text-red-600 dark:text-red-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Exact Online</CardTitle>
                      <Badge variant="secondary" className="mt-1">Accounting</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Sync invoices, expenses, and financial data with Exact Online
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* WooCommerce */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-violet-100 dark:bg-violet-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">WooCommerce</CardTitle>
                      <Badge variant="secondary" className="mt-1">E-Commerce</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Import products, orders, and customers from WooCommerce
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Shopify */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Shopify</CardTitle>
                      <Badge variant="secondary" className="mt-1">E-Commerce</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Sync your Shopify store with products and orders
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Slack */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-pink-100 dark:bg-pink-950 flex items-center justify-center">
                      <MessageCircle className="h-5 w-5 text-pink-600 dark:text-pink-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Slack</CardTitle>
                      <Badge variant="secondary" className="mt-1">Communication</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Get notifications and updates in your Slack channels
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* QuickBooks */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-950 flex items-center justify-center">
                      <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">QuickBooks</CardTitle>
                      <Badge variant="secondary" className="mt-1">Accounting</Badge>
                    </div>
                  </div>
                  <Switch />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Connect your QuickBooks account for seamless accounting
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button size="sm" className="flex-1">
                    Connect
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* PrintNode */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">PrintNode</CardTitle>
                      <Badge variant="secondary" className="mt-1">Printing</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Connect your label printers for automated printing
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="connected" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {/* DHL - Connected */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">DHL</CardTitle>
                      <Badge variant="secondary" className="mt-1">Shipping</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Manage shipments and track packages with DHL integration
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* WooCommerce - Connected */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-violet-100 dark:bg-violet-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">WooCommerce</CardTitle>
                      <Badge variant="secondary" className="mt-1">E-Commerce</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Import products, orders, and customers from WooCommerce
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* PrintNode - Connected */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-950 flex items-center justify-center">
                      <Activity className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">PrintNode</CardTitle>
                      <Badge variant="secondary" className="mt-1">Printing</Badge>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Connect your label printers for automated printing
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Settings className="h-3 w-3 mr-2" />
                    Configure
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    Disconnect
                  </Button>
                </div>
                <div className="mt-3 p-2 rounded-md bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                    <span className="text-xs text-green-700 dark:text-green-300">Connected</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="communication" className="space-y-4">
          <p className="text-sm text-muted-foreground">Communication integrations help you stay connected with your team.</p>
        </TabsContent>

        <TabsContent value="shipping" className="space-y-4">
          <p className="text-sm text-muted-foreground">Shipping integrations for managing deliveries and logistics.</p>
        </TabsContent>

        <TabsContent value="accounting" className="space-y-4">
          <p className="text-sm text-muted-foreground">Accounting integrations for financial management and reporting.</p>
        </TabsContent>

        <TabsContent value="ecommerce" className="space-y-4">
          <p className="text-sm text-muted-foreground">E-commerce integrations for online stores and marketplaces.</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
