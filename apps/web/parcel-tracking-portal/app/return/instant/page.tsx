"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Badge } from "@weldsuite/ui/components/badge";
import { Alert, AlertDescription, AlertTitle } from "@weldsuite/ui/components/alert";
import {
  ArrowLeft,
  Home,
  Zap,
  QrCode,
  Store,
  MapPin,
  Clock,
  CheckCircle,
  Package,
  RotateCcw,
  AlertCircle,
  CreditCard,
  Search
} from "lucide-react";
import { toast } from "sonner";

// Sample eligible items for instant return
const INSTANT_RETURN_ITEMS = [
  {
    orderNumber: "ORD-789012",
    itemId: "ITM-001",
    name: "Wireless Headphones",
    price: 149.99,
    purchaseDate: "2024-01-10",
    image: "🎧",
    eligibleUntil: "2024-02-09",
    nearestStore: "NYC Store - 5th Avenue",
    storeDistance: "2.3 miles",
    instantRefundAmount: 149.99
  },
  {
    orderNumber: "ORD-345678",
    itemId: "ITM-002",
    name: "Smart Watch",
    price: 299.99,
    purchaseDate: "2024-01-08",
    image: "⌚",
    eligibleUntil: "2024-02-07",
    nearestStore: "NYC Store - Times Square",
    storeDistance: "3.1 miles",
    instantRefundAmount: 299.99
  }
];

const NEARBY_STORES = [
  {
    id: "store-1",
    name: "NYC Store - 5th Avenue",
    address: "767 5th Avenue, New York, NY 10153",
    distance: "2.3 miles",
    hours: "Mon-Sat 10am-9pm, Sun 11am-7pm",
    phone: "(212) 555-0100",
    hasInstantReturn: true
  },
  {
    id: "store-2",
    name: "NYC Store - Times Square",
    address: "1535 Broadway, New York, NY 10036",
    distance: "3.1 miles",
    hours: "Mon-Sat 9am-10pm, Sun 10am-8pm",
    phone: "(212) 555-0200",
    hasInstantReturn: true
  },
  {
    id: "store-3",
    name: "NYC Store - Union Square",
    address: "33 Union Square W, New York, NY 10003",
    distance: "4.5 miles",
    hours: "Mon-Fri 10am-8pm, Sat-Sun 10am-7pm",
    phone: "(212) 555-0300",
    hasInstantReturn: true
  }
];

export default function InstantReturnPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [selectedStore, setSelectedStore] = useState<any>(null);
  const [showQRCode, setShowQRCode] = useState(false);

  const handleSearch = () => {
    if (!searchTerm) {
      toast.error("Please enter an order or item number");
      return;
    }

    const item = INSTANT_RETURN_ITEMS.find(
      i => i.orderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
           i.itemId.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (item) {
      setSelectedItem(item);
    } else {
      toast.error("No eligible items found for instant return");
    }
  };

  const handleGenerateCode = () => {
    if (!selectedStore) {
      toast.error("Please select a store first");
      return;
    }

    setShowQRCode(true);
    toast.success("Instant return code generated! Show this at the store.");
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
        <div className="max-w-5xl mx-auto">
          {/* Back Button */}
          <Link href="/" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-6">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Portal
          </Link>

          {/* Page Title */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-2">
              <Zap className="h-8 w-8 text-yellow-500" />
              Instant Return
            </h1>
            <p className="text-gray-600">Get instant refunds at participating stores - no shipping required!</p>
          </div>

          {/* Info Alert */}
          <Alert className="mb-8 border-green-200 bg-green-50">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-900">How Instant Returns Work</AlertTitle>
            <AlertDescription className="text-green-800">
              <ul className="mt-2 space-y-1 text-sm">
                <li>• Get your refund immediately - no waiting</li>
                <li>• Drop off items at any participating store</li>
                <li>• No packaging or shipping labels needed</li>
                <li>• Available for eligible items within 30 days of purchase</li>
              </ul>
            </AlertDescription>
          </Alert>

          {/* Search Section */}
          {!selectedItem && (
            <Card className="mb-8">
              <CardHeader>
                <CardTitle>Find Eligible Items</CardTitle>
                <CardDescription>
                  Enter your order number to see items eligible for instant return
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-4">
                  <Input
                    placeholder="Enter order number (e.g., ORD-789012)"
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
              </CardContent>
            </Card>
          )}

          {/* Selected Item */}
          {selectedItem && !showQRCode && (
            <>
              <Card className="mb-8 border-blue-200">
                <CardHeader>
                  <CardTitle>Eligible Item</CardTitle>
                  <Badge className="w-fit bg-green-500 text-white">
                    <Zap className="h-3 w-3 mr-1" />
                    Instant Return Available
                  </Badge>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start gap-4">
                    <div className="text-4xl">{selectedItem.image}</div>
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold mb-1">{selectedItem.name}</h3>
                      <p className="text-sm text-gray-600 mb-2">Order #{selectedItem.orderNumber}</p>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <p className="text-gray-600">Purchase Date</p>
                          <p className="font-medium">{selectedItem.purchaseDate}</p>
                        </div>
                        <div>
                          <p className="text-gray-600">Refund Amount</p>
                          <p className="font-medium text-green-600">${selectedItem.instantRefundAmount}</p>
                        </div>
                        <div>
                          <p className="text-gray-600">Eligible Until</p>
                          <p className="font-medium">{selectedItem.eligibleUntil}</p>
                        </div>
                        <div>
                          <p className="text-gray-600">Nearest Store</p>
                          <p className="font-medium">{selectedItem.nearestStore}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelectedItem(null);
                        setSearchTerm("");
                      }}
                    >
                      Search Another Item
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Store Selection */}
              <Card className="mb-8">
                <CardHeader>
                  <CardTitle>Select a Store</CardTitle>
                  <CardDescription>Choose where you'd like to return your item</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {NEARBY_STORES.map((store) => (
                    <div
                      key={store.id}
                      className={`p-4 border rounded-lg cursor-pointer transition-all ${
                        selectedStore?.id === store.id
                          ? "border-blue-600 bg-blue-50"
                          : "hover:border-gray-400"
                      }`}
                      onClick={() => setSelectedStore(store)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Store className="h-4 w-4 text-gray-600" />
                            <h4 className="font-semibold">{store.name}</h4>
                            {selectedStore?.id === store.id && (
                              <Badge className="bg-blue-600 text-white">Selected</Badge>
                            )}
                          </div>
                          <div className="text-sm text-gray-600 space-y-1">
                            <p className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {store.address}
                            </p>
                            <p className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {store.hours}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-medium text-blue-600">{store.distance}</p>
                          <p className="text-sm text-gray-600">{store.phone}</p>
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button
                    onClick={handleGenerateCode}
                    disabled={!selectedStore}
                    className="w-full"
                    size="lg"
                  >
                    Generate Return Code
                  </Button>
                </CardContent>
              </Card>
            </>
          )}

          {/* QR Code Display */}
          {showQRCode && (
            <Card className="mb-8 text-center">
              <CardHeader>
                <CardTitle className="text-2xl">Your Instant Return Code</CardTitle>
                <CardDescription>Show this code at {selectedStore.name}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="bg-white p-8 rounded-lg inline-block mb-6">
                  <QrCode className="h-48 w-48 text-gray-800" />
                </div>
                <div className="space-y-2 text-sm">
                  <p className="font-mono text-lg font-bold">IRT-2024-0115-7890</p>
                  <p className="text-gray-600">Valid for 24 hours</p>
                </div>

                <Alert className="mt-6 text-left">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>What to Bring</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-2 space-y-1 text-sm">
                      <li>• The item you're returning (no packaging needed)</li>
                      <li>• This QR code on your phone or printed</li>
                      <li>• A valid ID matching the order name</li>
                    </ul>
                  </AlertDescription>
                </Alert>

                <div className="mt-6 grid grid-cols-2 gap-4">
                  <Button variant="outline" onClick={() => window.print()}>
                    Print Code
                  </Button>
                  <Button variant="outline" onClick={() => toast.success("Code sent to your email")}>
                    Email Code
                  </Button>
                </div>

                <div className="mt-8 p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-semibold mb-2">Store Details</h4>
                  <div className="text-sm text-gray-600 space-y-1">
                    <p>{selectedStore.name}</p>
                    <p>{selectedStore.address}</p>
                    <p>{selectedStore.hours}</p>
                    <p className="font-medium text-blue-600">{selectedStore.phone}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Benefits Card */}
          <Card className="bg-gradient-to-r from-yellow-50 to-orange-50 border-yellow-200">
            <CardHeader>
              <CardTitle>Benefits of Instant Returns</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-3 gap-4">
                <div className="text-center">
                  <CreditCard className="h-10 w-10 text-yellow-600 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">Immediate Refund</h4>
                  <p className="text-sm text-gray-600">Get your money back instantly</p>
                </div>
                <div className="text-center">
                  <Package className="h-10 w-10 text-orange-600 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">No Packaging</h4>
                  <p className="text-sm text-gray-600">No boxes or labels needed</p>
                </div>
                <div className="text-center">
                  <Clock className="h-10 w-10 text-red-600 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">Save Time</h4>
                  <p className="text-sm text-gray-600">Complete return in minutes</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}