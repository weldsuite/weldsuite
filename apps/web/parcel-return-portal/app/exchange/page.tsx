"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { RadioGroup, RadioGroupItem } from "@weldsuite/ui/components/radio-group";
import { Label } from "@weldsuite/ui/components/label";
import { Badge } from "@weldsuite/ui/components/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weldsuite/ui/components/select";
import {
  ArrowLeft,
  Home,
  RotateCcw,
  Package,
  Truck,
  CheckCircle,
  ArrowRight,
  Search,
  ShoppingCart,
  Palette,
  Ruler,
  AlertCircle,
  Zap
} from "lucide-react";
import { toast } from "sonner";

// Sample order data
const SAMPLE_ORDERS = [
  {
    orderNumber: "ORD-789012",
    date: "2024-01-10",
    items: [
      {
        id: "ITM-001",
        name: "Wireless Headphones",
        price: 149.99,
        quantity: 1,
        image: "🎧",
        exchangeOptions: [
          { id: "opt-1", name: "Same Item - Black", available: true, price: 149.99 },
          { id: "opt-2", name: "Same Item - White", available: true, price: 149.99 },
          { id: "opt-3", name: "Premium Model - Black", available: true, price: 199.99 },
          { id: "opt-4", name: "Premium Model - Silver", available: false, price: 199.99 }
        ],
        sizes: [],
        colors: ["Black", "White", "Blue", "Red"]
      },
      {
        id: "ITM-002",
        name: "Bluetooth Speaker",
        price: 79.99,
        quantity: 1,
        image: "🔊",
        exchangeOptions: [
          { id: "opt-5", name: "Same Model - Black", available: true, price: 79.99 },
          { id: "opt-6", name: "Waterproof Model", available: true, price: 99.99 }
        ],
        sizes: [],
        colors: ["Black", "Blue", "Green"]
      }
    ]
  },
  {
    orderNumber: "ORD-345678",
    date: "2024-01-08",
    items: [
      {
        id: "ITM-003",
        name: "Running Shoes",
        price: 129.99,
        quantity: 1,
        image: "👟",
        exchangeOptions: [
          { id: "opt-7", name: "Same Model - Size 9", available: true, price: 129.99 },
          { id: "opt-8", name: "Same Model - Size 10", available: true, price: 129.99 },
          { id: "opt-9", name: "Trail Version", available: true, price: 149.99 }
        ],
        sizes: ["8", "8.5", "9", "9.5", "10", "10.5", "11"],
        colors: ["Black/White", "Blue/Gray", "Red/Black"]
      }
    ]
  }
];

export default function ExchangePage() {
  const [orderNumber, setOrderNumber] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [exchangeOption, setExchangeOption] = useState("");
  const [exchangeSize, setExchangeSize] = useState("");
  const [exchangeColor, setExchangeColor] = useState("");
  const [exchangeReason, setExchangeReason] = useState("");
  const [step, setStep] = useState(1);

  const handleOrderSearch = () => {
    if (!orderNumber) {
      toast.error("Please enter an order number");
      return;
    }

    const order = SAMPLE_ORDERS.find(o =>
      o.orderNumber.toLowerCase() === orderNumber.toLowerCase()
    );

    if (order) {
      setSelectedOrder(order);
      setStep(2);
    } else {
      toast.error("Order not found. Please check the order number.");
    }
  };

  const handleItemSelect = (item: any) => {
    setSelectedItem(item);
    setStep(3);
  };

  const handleExchangeSubmit = () => {
    if (!exchangeOption) {
      toast.error("Please select an exchange option");
      return;
    }
    if (!exchangeReason) {
      toast.error("Please select a reason for exchange");
      return;
    }

    toast.success("Exchange initiated! You'll receive a confirmation email with shipping details.");
    setStep(4);
  };

  const reasons = [
    "Wrong size",
    "Wrong color",
    "Defective item",
    "Not as described",
    "Changed mind",
    "Better model available"
  ];

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
        <div className="max-w-4xl mx-auto">
          {/* Back Button */}
          <Link href="/" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-6">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Portal
          </Link>

          {/* Page Title */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Exchange Items</h1>
            <p className="text-gray-600">Swap your items for different sizes, colors, or models</p>
          </div>

          {/* Progress Indicator */}
          <div className="flex items-center justify-between mb-8">
            {[1, 2, 3, 4].map((s) => (
              <div key={s} className="flex items-center flex-1">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  step >= s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                }`}>
                  {step > s ? <CheckCircle className="h-6 w-6" /> : s}
                </div>
                {s < 4 && (
                  <div className={`flex-1 h-1 mx-2 ${
                    step > s ? 'bg-blue-600' : 'bg-gray-200'
                  }`} />
                )}
              </div>
            ))}
          </div>

          {/* Step 1: Order Search */}
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Find Your Order</CardTitle>
                <CardDescription>Enter your order number to see items available for exchange</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex gap-4">
                    <Input
                      placeholder="Enter order number (e.g., ORD-789012)"
                      value={orderNumber}
                      onChange={(e) => setOrderNumber(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleOrderSearch()}
                      className="flex-1"
                    />
                    <Button onClick={handleOrderSearch}>
                      <Search className="h-4 w-4 mr-2" />
                      Search
                    </Button>
                  </div>

                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-900 font-medium mb-1">Quick Exchange Available</p>
                    <p className="text-sm text-blue-800">
                      Exchange items quickly with free shipping both ways. New items ship immediately!
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Item Selection */}
          {step === 2 && selectedOrder && (
            <Card>
              <CardHeader>
                <CardTitle>Select Item to Exchange</CardTitle>
                <CardDescription>Order #{selectedOrder.orderNumber} - {selectedOrder.date}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {selectedOrder.items.map((item: any) => (
                    <div
                      key={item.id}
                      className="p-4 border rounded-lg hover:border-blue-600 cursor-pointer transition-all"
                      onClick={() => handleItemSelect(item)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="text-3xl">{item.image}</div>
                          <div>
                            <h4 className="font-semibold">{item.name}</h4>
                            <p className="text-sm text-gray-600">${item.price}</p>
                          </div>
                        </div>
                        <ArrowRight className="h-5 w-5 text-gray-400" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Exchange Options */}
          {step === 3 && selectedItem && (
            <Card>
              <CardHeader>
                <CardTitle>Choose Exchange Option</CardTitle>
                <CardDescription>Exchanging: {selectedItem.name}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Current Item */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-600 mb-2">Current Item</p>
                  <div className="flex items-center gap-3">
                    <div className="text-2xl">{selectedItem.image}</div>
                    <div>
                      <p className="font-semibold">{selectedItem.name}</p>
                      <p className="text-sm text-gray-600">${selectedItem.price}</p>
                    </div>
                  </div>
                </div>

                {/* Exchange Options */}
                <div>
                  <Label className="mb-3 block">Select New Item</Label>
                  <RadioGroup value={exchangeOption} onValueChange={setExchangeOption}>
                    {selectedItem.exchangeOptions.map((option: any) => (
                      <div key={option.id} className="flex items-center space-x-2 mb-3">
                        <RadioGroupItem
                          value={option.id}
                          id={option.id}
                          disabled={!option.available}
                        />
                        <Label
                          htmlFor={option.id}
                          className={`flex-1 cursor-pointer ${!option.available ? 'opacity-50' : ''}`}
                        >
                          <div className="flex items-center justify-between">
                            <span>{option.name}</span>
                            <div className="flex items-center gap-2">
                              {option.price > selectedItem.price && (
                                <Badge variant="outline">+${(option.price - selectedItem.price).toFixed(2)}</Badge>
                              )}
                              {option.price === selectedItem.price && (
                                <Badge className="bg-green-500 text-white">Even Exchange</Badge>
                              )}
                              {!option.available && (
                                <Badge variant="secondary">Out of Stock</Badge>
                              )}
                            </div>
                          </div>
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </div>

                {/* Size Selection */}
                {selectedItem.sizes.length > 0 && (
                  <div>
                    <Label className="mb-3 block">Select Size</Label>
                    <Select value={exchangeSize} onValueChange={setExchangeSize}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose size" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedItem.sizes.map((size: string) => (
                          <SelectItem key={size} value={size}>
                            Size {size}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Color Selection */}
                {selectedItem.colors.length > 0 && (
                  <div>
                    <Label className="mb-3 block">Select Color</Label>
                    <Select value={exchangeColor} onValueChange={setExchangeColor}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose color" />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedItem.colors.map((color: string) => (
                          <SelectItem key={color} value={color}>
                            {color}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Reason for Exchange */}
                <div>
                  <Label className="mb-3 block">Reason for Exchange</Label>
                  <Select value={exchangeReason} onValueChange={setExchangeReason}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a reason" />
                    </SelectTrigger>
                    <SelectContent>
                      {reasons.map((reason) => (
                        <SelectItem key={reason} value={reason}>
                          {reason}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(2)}>
                    Back
                  </Button>
                  <Button onClick={handleExchangeSubmit} className="flex-1">
                    Confirm Exchange
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 4: Confirmation */}
          {step === 4 && (
            <Card className="text-center">
              <CardContent className="pt-12 pb-8">
                <CheckCircle className="h-16 w-16 text-green-600 mx-auto mb-4" />
                <h2 className="text-2xl font-bold mb-2">Exchange Initiated!</h2>
                <p className="text-gray-600 mb-6">
                  Your exchange request has been processed successfully
                </p>

                <div className="bg-gray-50 p-6 rounded-lg mb-6 text-left max-w-md mx-auto">
                  <h3 className="font-semibold mb-3">What's Next?</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-start gap-3">
                      <Truck className="h-5 w-5 text-blue-600 mt-0.5" />
                      <div>
                        <p className="font-medium">New Item Ships Immediately</p>
                        <p className="text-gray-600">Your replacement will be shipped within 24 hours</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Package className="h-5 w-5 text-purple-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Return Label Sent</p>
                        <p className="text-gray-600">Check your email for the prepaid return label</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Zap className="h-5 w-5 text-yellow-600 mt-0.5" />
                      <div>
                        <p className="font-medium">30 Days to Return</p>
                        <p className="text-gray-600">Send back the original item within 30 days</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <p className="text-sm text-gray-600 mb-2">Exchange ID</p>
                  <p className="font-mono text-lg font-bold mb-6">EXC-2024-0115-{Math.random().toString(36).substr(2, 9).toUpperCase()}</p>
                </div>

                <div className="flex gap-3 justify-center">
                  <Link href="/track">
                    <Button variant="outline">
                      Track Exchange
                    </Button>
                  </Link>
                  <Link href="/">
                    <Button>
                      Back to Home
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Info Cards */}
          {step === 1 && (
            <div className="grid md:grid-cols-3 gap-4 mt-8">
              <Card className="text-center">
                <CardContent className="pt-6">
                  <Zap className="h-10 w-10 text-yellow-500 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">Fast Shipping</h4>
                  <p className="text-sm text-gray-600">New items ship immediately</p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6">
                  <RotateCcw className="h-10 w-10 text-blue-600 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">Easy Returns</h4>
                  <p className="text-sm text-gray-600">Free return shipping included</p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6">
                  <ShoppingCart className="h-10 w-10 text-purple-600 mx-auto mb-2" />
                  <h4 className="font-semibold mb-1">Wide Selection</h4>
                  <p className="text-sm text-gray-600">Multiple options available</p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}