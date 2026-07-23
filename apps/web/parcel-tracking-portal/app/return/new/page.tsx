"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";
import { Textarea } from "@weldsuite/ui/components/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { RadioGroup, RadioGroupItem } from "@weldsuite/ui/components/radio-group";
import { Checkbox } from "@weldsuite/ui/components/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weldsuite/ui/components/select";
import {
  Package,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  Home,
  AlertCircle,
  CheckCircle,
  Info,
} from "lucide-react";
import { toast } from "sonner";

// Sample order data
const SAMPLE_ORDERS = {
  "ORD-789012": {
    orderNumber: "ORD-789012",
    orderDate: "2024-01-10",
    items: [
      { id: "1", name: "Wireless Headphones", sku: "WH-001", price: 149.99, quantity: 1, image: "/api/placeholder/100/100" },
      { id: "2", name: "USB-C Cable", sku: "UC-002", price: 19.99, quantity: 2, image: "/api/placeholder/100/100" },
      { id: "3", name: "Phone Case", sku: "PC-003", price: 29.99, quantity: 1, image: "/api/placeholder/100/100" },
    ],
    customer: {
      name: "John Doe",
      email: "john.doe@email.com",
      phone: "+1 (555) 123-4567",
      address: "123 Main St, Apt 4B, New York, NY 10001"
    }
  },
  "ORD-345678": {
    orderNumber: "ORD-345678",
    orderDate: "2024-01-05",
    items: [
      { id: "4", name: "Smart Watch", sku: "SW-001", price: 299.99, quantity: 1, image: "/api/placeholder/100/100" },
      { id: "5", name: "Watch Band", sku: "WB-002", price: 39.99, quantity: 1, image: "/api/placeholder/100/100" },
    ],
    customer: {
      name: "Jane Smith",
      email: "jane.smith@email.com",
      phone: "+1 (555) 987-6543",
      address: "456 Oak Ave, Los Angeles, CA 90001"
    }
  }
};

const RETURN_REASONS = [
  "Defective or damaged product",
  "Wrong item received",
  "Not as described",
  "No longer needed",
  "Better price available",
  "Arrived too late",
  "Other"
];

export default function NewReturnPage() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams.get("order") || "";

  const [step, setStep] = useState(1);
  const [orderInput, setOrderInput] = useState(orderNumber);
  const [orderData, setOrderData] = useState<any>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [returnType, setReturnType] = useState("refund");
  const [returnReasons, setReturnReasons] = useState<Record<string, string>>({});
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [shippingMethod, setShippingMethod] = useState("dropoff");

  const handleOrderLookup = () => {
    if (!orderInput) {
      toast.error("Please enter an order number");
      return;
    }

    const order = SAMPLE_ORDERS[orderInput as keyof typeof SAMPLE_ORDERS];
    if (order) {
      setOrderData(order);
      setStep(2);
    } else {
      toast.error("Order not found. Please check the order number.");
    }
  };

  const handleItemToggle = (itemId: string) => {
    setSelectedItems(prev =>
      prev.includes(itemId)
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    );
  };

  const handleReasonChange = (itemId: string, reason: string) => {
    setReturnReasons(prev => ({ ...prev, [itemId]: reason }));
  };

  const calculateRefundAmount = () => {
    if (!orderData) return 0;
    return orderData.items
      .filter((item: any) => selectedItems.includes(item.id))
      .reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
  };

  const handleSubmit = () => {
    // Validate selections
    if (selectedItems.length === 0) {
      toast.error("Please select at least one item to return");
      return;
    }

    // Check if all selected items have reasons
    const missingReasons = selectedItems.filter(id => !returnReasons[id]);
    if (missingReasons.length > 0) {
      toast.error("Please select a return reason for all selected items");
      return;
    }

    // Generate return ID
    const returnId = `RET-${Date.now().toString().slice(-6)}`;

    toast.success(`Return initiated successfully! Your return ID is ${returnId}`);

    // Redirect to tracking page
    setTimeout(() => {
      window.location.href = `/track/${returnId}`;
    }, 2000);
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
        <div className="max-w-4xl mx-auto">
          {/* Progress Steps */}
          <div className="flex items-center justify-center mb-8">
            <div className="flex items-center gap-4">
              <div className={`flex items-center gap-2 ${step >= 1 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  step >= 1 ? 'bg-blue-600 text-white' : 'bg-gray-200'
                }`}>
                  1
                </div>
                <span className="hidden sm:inline">Order Details</span>
              </div>
              <div className={`w-16 h-0.5 ${step >= 2 ? 'bg-blue-600' : 'bg-gray-200'}`} />
              <div className={`flex items-center gap-2 ${step >= 2 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  step >= 2 ? 'bg-blue-600 text-white' : 'bg-gray-200'
                }`}>
                  2
                </div>
                <span className="hidden sm:inline">Select Items</span>
              </div>
              <div className={`w-16 h-0.5 ${step >= 3 ? 'bg-blue-600' : 'bg-gray-200'}`} />
              <div className={`flex items-center gap-2 ${step >= 3 ? 'text-blue-600' : 'text-gray-400'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  step >= 3 ? 'bg-blue-600 text-white' : 'bg-gray-200'
                }`}>
                  3
                </div>
                <span className="hidden sm:inline">Return Details</span>
              </div>
            </div>
          </div>

          {/* Step 1: Order Lookup */}
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Start Your Return</CardTitle>
                <CardDescription>
                  Enter your order number to begin the return process
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="orderNumber">Order Number</Label>
                    <Input
                      id="orderNumber"
                      placeholder="e.g., ORD-789012"
                      value={orderInput}
                      onChange={(e) => setOrderInput(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleOrderLookup()}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      You can find your order number in your confirmation email
                    </p>
                  </div>
                  <Button onClick={handleOrderLookup} className="w-full">
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>

                  <div className="pt-4 border-t">
                    <p className="text-sm text-gray-600 mb-2">Try these sample order numbers:</p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOrderInput("ORD-789012")}
                      >
                        ORD-789012
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOrderInput("ORD-345678")}
                      >
                        ORD-345678
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: Select Items */}
          {step === 2 && orderData && (
            <Card>
              <CardHeader>
                <CardTitle>Select Items to Return</CardTitle>
                <CardDescription>
                  Order #{orderData.orderNumber} • Placed on {orderData.orderDate}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {orderData.items.map((item: any) => (
                    <div key={item.id} className="border rounded-lg p-4">
                      <div className="flex items-start gap-4">
                        <Checkbox
                          id={item.id}
                          checked={selectedItems.includes(item.id)}
                          onCheckedChange={() => handleItemToggle(item.id)}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-4">
                            <div className="w-16 h-16 bg-gray-100 rounded" />
                            <div className="flex-1">
                              <h4 className="font-medium">{item.name}</h4>
                              <p className="text-sm text-gray-600">SKU: {item.sku}</p>
                              <p className="text-sm">Quantity: {item.quantity}</p>
                            </div>
                            <div className="text-right">
                              <p className="font-semibold">${(item.price * item.quantity).toFixed(2)}</p>
                            </div>
                          </div>

                          {selectedItems.includes(item.id) && (
                            <div className="mt-4 pl-20">
                              <Label htmlFor={`reason-${item.id}`}>Return Reason</Label>
                              <Select
                                value={returnReasons[item.id]}
                                onValueChange={(value) => handleReasonChange(item.id, value)}
                              >
                                <SelectTrigger id={`reason-${item.id}`}>
                                  <SelectValue placeholder="Select a reason" />
                                </SelectTrigger>
                                <SelectContent>
                                  {RETURN_REASONS.map(reason => (
                                    <SelectItem key={reason} value={reason}>
                                      {reason}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  <div className="flex justify-between pt-4">
                    <Button variant="outline" onClick={() => setStep(1)}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Back
                    </Button>
                    <Button
                      onClick={() => setStep(3)}
                      disabled={selectedItems.length === 0}
                    >
                      Continue
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Return Details */}
          {step === 3 && orderData && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Return Details</CardTitle>
                  <CardDescription>
                    Complete your return request
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Return Type */}
                  <div>
                    <Label>What would you like?</Label>
                    <RadioGroup value={returnType} onValueChange={setReturnType} className="mt-2">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="refund" id="refund" />
                        <Label htmlFor="refund">Refund to original payment method</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="exchange" id="exchange" />
                        <Label htmlFor="exchange">Exchange for a different item</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="credit" id="credit" />
                        <Label htmlFor="credit">Store credit</Label>
                      </div>
                    </RadioGroup>
                  </div>

                  {/* Shipping Method */}
                  <div>
                    <Label>How will you return the items?</Label>
                    <RadioGroup value={shippingMethod} onValueChange={setShippingMethod} className="mt-2">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="dropoff" id="dropoff" />
                        <Label htmlFor="dropoff">Drop off at shipping location (Free)</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="pickup" id="pickup" />
                        <Label htmlFor="pickup">Schedule a pickup ($5.99)</Label>
                      </div>
                    </RadioGroup>
                  </div>

                  {/* Additional Notes */}
                  <div>
                    <Label htmlFor="notes">Additional Notes (Optional)</Label>
                    <Textarea
                      id="notes"
                      placeholder="Any additional information about your return..."
                      value={additionalNotes}
                      onChange={(e) => setAdditionalNotes(e.target.value)}
                      rows={3}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Return Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Return Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Items to Return</span>
                      <span className="font-medium">{selectedItems.length} item(s)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Return Type</span>
                      <span className="font-medium capitalize">{returnType}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Shipping Method</span>
                      <span className="font-medium">
                        {shippingMethod === 'dropoff' ? 'Drop Off (Free)' : 'Pickup ($5.99)'}
                      </span>
                    </div>
                    <div className="border-t pt-3">
                      <div className="flex justify-between text-lg">
                        <span className="font-semibold">Refund Amount</span>
                        <span className="font-semibold text-green-600">
                          ${calculateRefundAmount().toFixed(2)}
                        </span>
                      </div>
                      {shippingMethod === 'pickup' && (
                        <p className="text-sm text-gray-600 mt-1">
                          *Pickup fee will be deducted from refund
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-start gap-2">
                        <Info className="h-5 w-5 text-blue-600 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-medium text-blue-900">What happens next?</p>
                          <ul className="mt-2 space-y-1 text-blue-800">
                            <li>• You'll receive a return label via email</li>
                            <li>• Pack your items securely</li>
                            <li>• Drop off at any shipping location or wait for pickup</li>
                            <li>• Refund processed within 3-5 business days of receipt</li>
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-between">
                      <Button variant="outline" onClick={() => setStep(2)}>
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back
                      </Button>
                      <Button onClick={handleSubmit}>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Submit Return
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}