"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Badge } from "@weldsuite/ui/components/badge";
import { Progress } from "@weldsuite/ui/components/progress";
import {
  Package,
  RotateCcw,
  ArrowLeft,
  CheckCircle,
  Clock,
  Truck,
  Home,
  AlertCircle,
  MapPin,
  Calendar,
  User,
  Mail,
  Phone,
  FileText,
  Download,
} from "lucide-react";

// Sample tracking data
const SAMPLE_RETURNS = {
  "RET-123456": {
    id: "RET-123456",
    status: "in_transit",
    progress: 60,
    orderNumber: "ORD-789012",
    createdAt: "2024-01-15",
    estimatedRefund: "2024-01-25",
    refundAmount: 149.99,
    items: [
      { name: "Wireless Headphones", quantity: 1, reason: "Defective" }
    ],
    customer: {
      name: "John Doe",
      email: "john.doe@email.com",
      phone: "+1 (555) 123-4567"
    },
    timeline: [
      { date: "2024-01-15 10:30 AM", status: "Return Initiated", description: "Return request approved", completed: true },
      { date: "2024-01-16 2:00 PM", status: "Label Generated", description: "Shipping label created", completed: true },
      { date: "2024-01-17 9:00 AM", status: "Package Picked Up", description: "Package collected by carrier", completed: true },
      { date: "2024-01-18 3:30 PM", status: "In Transit", description: "Package on the way to our facility", completed: true, current: true },
      { date: "Expected: 2024-01-20", status: "Processing", description: "Return being processed", completed: false },
      { date: "Expected: 2024-01-25", status: "Refund Issued", description: "Refund sent to original payment method", completed: false },
    ]
  },
  "RET-789012": {
    id: "RET-789012",
    status: "processing",
    progress: 80,
    orderNumber: "ORD-345678",
    createdAt: "2024-01-10",
    estimatedRefund: "2024-01-20",
    refundAmount: 89.50,
    items: [
      { name: "Smart Watch", quantity: 1, reason: "Not as described" }
    ],
    customer: {
      name: "Jane Smith",
      email: "jane.smith@email.com",
      phone: "+1 (555) 987-6543"
    },
    timeline: [
      { date: "2024-01-10 11:00 AM", status: "Return Initiated", description: "Return request approved", completed: true },
      { date: "2024-01-11 1:00 PM", status: "Label Generated", description: "Shipping label created", completed: true },
      { date: "2024-01-12 10:00 AM", status: "Package Picked Up", description: "Package collected by carrier", completed: true },
      { date: "2024-01-15 4:00 PM", status: "Delivered to Facility", description: "Package received at our warehouse", completed: true },
      { date: "2024-01-18 2:00 PM", status: "Processing", description: "Quality check in progress", completed: true, current: true },
      { date: "Expected: 2024-01-20", status: "Refund Issued", description: "Refund will be sent to original payment method", completed: false },
    ]
  }
};

export default function TrackingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [returnData, setReturnData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate loading delay
    setTimeout(() => {
      const data = SAMPLE_RETURNS[id as keyof typeof SAMPLE_RETURNS];
      setReturnData(data);
      setLoading(false);
    }, 500);
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-4xl mx-auto text-center">
            <div className="animate-pulse">
              <div className="h-8 bg-gray-200 rounded w-1/3 mx-auto mb-4"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2 mx-auto"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!returnData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-4xl mx-auto text-center">
            <AlertCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Return Not Found</h1>
            <p className="text-gray-600 mb-8">
              We couldn't find a return with tracking number: {id}
            </p>
            <Link href="/">
              <Button>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Home
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "initiated": return "bg-blue-500";
      case "in_transit": return "bg-yellow-500";
      case "processing": return "bg-purple-500";
      case "completed": return "bg-green-500";
      case "refunded": return "bg-green-600";
      default: return "bg-gray-500";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "initiated": return <Clock className="h-5 w-5" />;
      case "in_transit": return <Truck className="h-5 w-5" />;
      case "processing": return <Package className="h-5 w-5" />;
      case "completed": return <CheckCircle className="h-5 w-5" />;
      case "refunded": return <CheckCircle className="h-5 w-5" />;
      default: return <AlertCircle className="h-5 w-5" />;
    }
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

          {/* Main Status Card */}
          <Card className="mb-8">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-2xl">Return #{returnData.id}</CardTitle>
                  <CardDescription>Order #{returnData.orderNumber}</CardDescription>
                </div>
                <Badge className={`${getStatusColor(returnData.status)} text-white px-4 py-2`}>
                  {getStatusIcon(returnData.status)}
                  <span className="ml-2 capitalize">{returnData.status.replace(/_/g, ' ')}</span>
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Progress Bar */}
                <div>
                  <div className="flex justify-between text-sm text-gray-600 mb-2">
                    <span>Return Progress</span>
                    <span>{returnData.progress}%</span>
                  </div>
                  <Progress value={returnData.progress} className="h-3" />
                </div>

                {/* Key Information */}
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="flex items-center gap-3">
                    <Calendar className="h-5 w-5 text-gray-400" />
                    <div>
                      <p className="text-sm text-gray-600">Return Started</p>
                      <p className="font-medium">{returnData.createdAt}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Clock className="h-5 w-5 text-gray-400" />
                    <div>
                      <p className="text-sm text-gray-600">Est. Refund Date</p>
                      <p className="font-medium">{returnData.estimatedRefund}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-gray-400" />
                    <div>
                      <p className="text-sm text-gray-600">Refund Amount</p>
                      <p className="font-medium text-green-600">${returnData.refundAmount.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-3 gap-6">
            {/* Timeline */}
            <div className="md:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Return Timeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {returnData.timeline.map((event: any, index: number) => (
                      <div key={index} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                            event.completed
                              ? event.current ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'
                              : 'bg-gray-200 text-gray-400'
                          }`}>
                            {event.completed ? <CheckCircle className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
                          </div>
                          {index < returnData.timeline.length - 1 && (
                            <div className={`w-0.5 h-16 ${event.completed ? 'bg-green-600' : 'bg-gray-200'}`} />
                          )}
                        </div>
                        <div className="flex-1 pb-8">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold">{event.status}</h4>
                            {event.current && <Badge variant="outline" className="text-xs">Current</Badge>}
                          </div>
                          <p className="text-sm text-gray-600 mb-1">{event.description}</p>
                          <p className="text-xs text-gray-400">{event.date}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Side Information */}
            <div className="space-y-6">
              {/* Items Being Returned */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Items Being Returned</CardTitle>
                </CardHeader>
                <CardContent>
                  {returnData.items.map((item: any, index: number) => (
                    <div key={index} className="space-y-2">
                      <div className="flex justify-between">
                        <span className="font-medium">{item.name}</span>
                        <span className="text-sm text-gray-600">Qty: {item.quantity}</span>
                      </div>
                      <p className="text-sm text-gray-600">Reason: {item.reason}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Customer Information */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Customer Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-gray-400" />
                    <span className="text-sm">{returnData.customer.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-gray-400" />
                    <span className="text-sm">{returnData.customer.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-gray-400" />
                    <span className="text-sm">{returnData.customer.phone}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Actions */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button className="w-full" variant="outline">
                    <Download className="h-4 w-4 mr-2" />
                    Download Return Label
                  </Button>
                  <Button className="w-full" variant="outline">
                    <FileText className="h-4 w-4 mr-2" />
                    View Return Policy
                  </Button>
                  <Button className="w-full" variant="outline">
                    <Mail className="h-4 w-4 mr-2" />
                    Contact Support
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}