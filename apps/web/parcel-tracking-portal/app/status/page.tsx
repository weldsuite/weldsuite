"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Badge } from "@weldsuite/ui/components/badge";
import { Progress } from "@weldsuite/ui/components/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weldsuite/ui/components/tabs";
import {
  ArrowLeft,
  Home,
  Search,
  Package,
  Truck,
  CheckCircle,
  Clock,
  AlertCircle,
  CreditCard,
  Calendar,
  FileText,
  MapPin,
  RotateCcw,
  Filter,
  Download
} from "lucide-react";
import { toast } from "sonner";

// Sample return data
const SAMPLE_RETURNS = [
  {
    id: "RET-123456",
    orderNumber: "ORD-789012",
    status: "in_transit",
    progress: 60,
    createdAt: "2024-01-15",
    estimatedRefund: "2024-01-25",
    refundAmount: 149.99,
    trackingNumber: "1Z999AA10123456784",
    carrier: "UPS",
    items: [
      { name: "Wireless Headphones", quantity: 1, reason: "Defective" }
    ],
    lastUpdate: "Package in transit - Expected delivery Jan 20"
  },
  {
    id: "RET-789012",
    orderNumber: "ORD-345678",
    status: "processing",
    progress: 80,
    createdAt: "2024-01-10",
    estimatedRefund: "2024-01-20",
    refundAmount: 89.50,
    trackingNumber: "1Z999AA10987654321",
    carrier: "FedEx",
    items: [
      { name: "Smart Watch", quantity: 1, reason: "Not as described" }
    ],
    lastUpdate: "Quality check in progress"
  },
  {
    id: "RET-456789",
    orderNumber: "ORD-234567",
    status: "completed",
    progress: 100,
    createdAt: "2024-01-05",
    estimatedRefund: "2024-01-12",
    refundAmount: 299.99,
    trackingNumber: "1Z999AA10456789123",
    carrier: "USPS",
    items: [
      { name: "Laptop Stand", quantity: 1, reason: "Changed mind" },
      { name: "USB-C Hub", quantity: 1, reason: "Not needed" }
    ],
    lastUpdate: "Refund issued on Jan 12"
  },
  {
    id: "RET-234567",
    orderNumber: "ORD-456789",
    status: "initiated",
    progress: 20,
    createdAt: "2024-01-18",
    estimatedRefund: "2024-01-28",
    refundAmount: 45.00,
    trackingNumber: "Pending",
    carrier: "TBD",
    items: [
      { name: "Phone Case", quantity: 2, reason: "Wrong model" }
    ],
    lastUpdate: "Waiting for you to ship the package"
  }
];

const SAMPLE_EXCHANGES = [
  {
    id: "EXC-001122",
    orderNumber: "ORD-112233",
    status: "new_item_shipped",
    createdAt: "2024-01-16",
    originalItem: "Running Shoes Size 9",
    newItem: "Running Shoes Size 10",
    newItemTracking: "1Z999BB10123456784",
    returnTracking: "Pending",
    lastUpdate: "Replacement shipped - arrives Jan 19"
  },
  {
    id: "EXC-003344",
    orderNumber: "ORD-445566",
    status: "completed",
    createdAt: "2024-01-08",
    originalItem: "Blue Shirt - M",
    newItem: "Blue Shirt - L",
    newItemTracking: "1Z999CC10987654321",
    returnTracking: "1Z999DD10456789123",
    lastUpdate: "Exchange completed on Jan 15"
  }
];

export default function StatusPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [filteredReturns, setFilteredReturns] = useState(SAMPLE_RETURNS);
  const [filteredExchanges, setFilteredExchanges] = useState(SAMPLE_EXCHANGES);

  const handleSearch = () => {
    if (!searchTerm) {
      setFilteredReturns(SAMPLE_RETURNS);
      setFilteredExchanges(SAMPLE_EXCHANGES);
      return;
    }

    const searchLower = searchTerm.toLowerCase();

    const returns = SAMPLE_RETURNS.filter(ret =>
      ret.id.toLowerCase().includes(searchLower) ||
      ret.orderNumber.toLowerCase().includes(searchLower) ||
      ret.trackingNumber.toLowerCase().includes(searchLower)
    );

    const exchanges = SAMPLE_EXCHANGES.filter(exc =>
      exc.id.toLowerCase().includes(searchLower) ||
      exc.orderNumber.toLowerCase().includes(searchLower)
    );

    setFilteredReturns(returns);
    setFilteredExchanges(exchanges);

    if (returns.length === 0 && exchanges.length === 0) {
      toast.error("No returns or exchanges found");
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "initiated": return "bg-blue-500";
      case "in_transit": return "bg-yellow-500";
      case "processing": return "bg-purple-500";
      case "completed": return "bg-green-500";
      case "new_item_shipped": return "bg-orange-500";
      default: return "bg-gray-500";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "initiated": return <Clock className="h-4 w-4" />;
      case "in_transit": return <Truck className="h-4 w-4" />;
      case "processing": return <Package className="h-4 w-4" />;
      case "completed": return <CheckCircle className="h-4 w-4" />;
      case "new_item_shipped": return <Truck className="h-4 w-4" />;
      default: return <AlertCircle className="h-4 w-4" />;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "initiated": return "Initiated";
      case "in_transit": return "In Transit";
      case "processing": return "Processing";
      case "completed": return "Completed";
      case "new_item_shipped": return "New Item Shipped";
      default: return status;
    }
  };

  const exportData = () => {
    toast.success("Export downloaded as CSV");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <RotateCcw className="h-6 w-6 text-blue-600" />
            <span className="font-bold text-xl">Returns Portal</span>
          </Link>
          <Link href="/">
            <Button variant="ghost" size="sm">
              <Home className="h-4 w-4 mr-2" />
              Home
            </Button>
          </Link>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto">
          {/* Back Button */}
          <Link href="/" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-6">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Portal
          </Link>

          {/* Page Title */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Check Status</h1>
            <p className="text-gray-600">View all your returns and exchanges in one place</p>
          </div>

          {/* Search and Actions */}
          <Card className="mb-8">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row gap-4">
                <div className="flex gap-2 flex-1">
                  <Input
                    placeholder="Search by return ID, order number, or tracking..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyPress={(e) => e.key === "Enter" && handleSearch()}
                    className="flex-1"
                  />
                  <Button onClick={handleSearch}>
                    <Search className="h-4 w-4 mr-2" />
                    Search
                  </Button>
                </div>
                <Button variant="outline" onClick={exportData}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Statistics */}
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Active Returns</p>
                    <p className="text-2xl font-bold">3</p>
                  </div>
                  <Package className="h-8 w-8 text-blue-600" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Completed</p>
                    <p className="text-2xl font-bold">1</p>
                  </div>
                  <CheckCircle className="h-8 w-8 text-green-600" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Total Refunds</p>
                    <p className="text-2xl font-bold">$584.48</p>
                  </div>
                  <CreditCard className="h-8 w-8 text-purple-600" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Exchanges</p>
                    <p className="text-2xl font-bold">2</p>
                  </div>
                  <RotateCcw className="h-8 w-8 text-orange-600" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="returns">Returns</TabsTrigger>
              <TabsTrigger value="exchanges">Exchanges</TabsTrigger>
            </TabsList>

            <TabsContent value="all" className="space-y-4">
              {/* Returns */}
              {filteredReturns.length > 0 && (
                <>
                  <h3 className="font-semibold text-lg mt-4">Returns</h3>
                  {filteredReturns.map((ret) => (
                    <Card key={ret.id} className="hover:shadow-lg transition-shadow">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold text-lg">{ret.id}</h4>
                              <Badge className={`${getStatusColor(ret.status)} text-white`}>
                                {getStatusIcon(ret.status)}
                                <span className="ml-1">{getStatusLabel(ret.status)}</span>
                              </Badge>
                            </div>
                            <p className="text-sm text-gray-600">Order #{ret.orderNumber}</p>
                          </div>
                          <Link href={`/track/${ret.id}`}>
                            <Button size="sm">View Details</Button>
                          </Link>
                        </div>

                        <Progress value={ret.progress} className="h-2 mb-4" />

                        <div className="grid md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <p className="text-gray-600">Created</p>
                            <p className="font-medium">{ret.createdAt}</p>
                          </div>
                          <div>
                            <p className="text-gray-600">Est. Refund</p>
                            <p className="font-medium">{ret.estimatedRefund}</p>
                          </div>
                          <div>
                            <p className="text-gray-600">Amount</p>
                            <p className="font-medium text-green-600">${ret.refundAmount}</p>
                          </div>
                          <div>
                            <p className="text-gray-600">Tracking</p>
                            <p className="font-medium font-mono text-xs">{ret.trackingNumber}</p>
                          </div>
                        </div>

                        <div className="mt-4 pt-4 border-t">
                          <p className="text-sm text-gray-600 flex items-center gap-2">
                            <AlertCircle className="h-4 w-4" />
                            {ret.lastUpdate}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </>
              )}

              {/* Exchanges */}
              {filteredExchanges.length > 0 && (
                <>
                  <h3 className="font-semibold text-lg mt-6">Exchanges</h3>
                  {filteredExchanges.map((exc) => (
                    <Card key={exc.id} className="hover:shadow-lg transition-shadow">
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold text-lg">{exc.id}</h4>
                              <Badge className={`${getStatusColor(exc.status)} text-white`}>
                                {getStatusIcon(exc.status)}
                                <span className="ml-1">{getStatusLabel(exc.status)}</span>
                              </Badge>
                            </div>
                            <p className="text-sm text-gray-600">Order #{exc.orderNumber}</p>
                          </div>
                        </div>

                        <div className="grid md:grid-cols-2 gap-4 mb-4">
                          <div className="p-3 bg-gray-50 rounded">
                            <p className="text-xs text-gray-600 mb-1">Original Item</p>
                            <p className="text-sm font-medium">{exc.originalItem}</p>
                            <p className="text-xs text-gray-600 mt-1">Return: {exc.returnTracking}</p>
                          </div>
                          <div className="p-3 bg-blue-50 rounded">
                            <p className="text-xs text-gray-600 mb-1">New Item</p>
                            <p className="text-sm font-medium">{exc.newItem}</p>
                            <p className="text-xs text-gray-600 mt-1">Tracking: {exc.newItemTracking}</p>
                          </div>
                        </div>

                        <p className="text-sm text-gray-600 flex items-center gap-2">
                          <AlertCircle className="h-4 w-4" />
                          {exc.lastUpdate}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </>
              )}
            </TabsContent>

            <TabsContent value="returns" className="space-y-4">
              {filteredReturns.map((ret) => (
                <Card key={ret.id} className="hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold text-lg">{ret.id}</h4>
                          <Badge className={`${getStatusColor(ret.status)} text-white`}>
                            {getStatusIcon(ret.status)}
                            <span className="ml-1">{getStatusLabel(ret.status)}</span>
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-600">Order #{ret.orderNumber}</p>
                      </div>
                      <Link href={`/track/${ret.id}`}>
                        <Button size="sm">View Details</Button>
                      </Link>
                    </div>

                    <Progress value={ret.progress} className="h-2 mb-4" />

                    <div className="grid md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-gray-600">Created</p>
                        <p className="font-medium">{ret.createdAt}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Est. Refund</p>
                        <p className="font-medium">{ret.estimatedRefund}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Amount</p>
                        <p className="font-medium text-green-600">${ret.refundAmount}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Items</p>
                        <p className="font-medium">{ret.items.length} item(s)</p>
                      </div>
                    </div>

                    <div className="mt-4 pt-4 border-t">
                      <p className="text-sm text-gray-600 flex items-center gap-2">
                        <AlertCircle className="h-4 w-4" />
                        {ret.lastUpdate}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="exchanges" className="space-y-4">
              {filteredExchanges.map((exc) => (
                <Card key={exc.id} className="hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold text-lg">{exc.id}</h4>
                          <Badge className={`${getStatusColor(exc.status)} text-white`}>
                            {getStatusIcon(exc.status)}
                            <span className="ml-1">{getStatusLabel(exc.status)}</span>
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-600">Order #{exc.orderNumber}</p>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4 mb-4">
                      <div className="p-3 bg-gray-50 rounded">
                        <p className="text-xs text-gray-600 mb-1">Original Item</p>
                        <p className="text-sm font-medium">{exc.originalItem}</p>
                        <p className="text-xs text-gray-600 mt-1">Return: {exc.returnTracking}</p>
                      </div>
                      <div className="p-3 bg-blue-50 rounded">
                        <p className="text-xs text-gray-600 mb-1">New Item</p>
                        <p className="text-sm font-medium">{exc.newItem}</p>
                        <p className="text-xs text-gray-600 mt-1">Tracking: {exc.newItemTracking}</p>
                      </div>
                    </div>

                    <p className="text-sm text-gray-600 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      {exc.lastUpdate}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}