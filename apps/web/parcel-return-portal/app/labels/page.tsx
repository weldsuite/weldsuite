"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Badge } from "@weldsuite/ui/components/badge";
import {
  ArrowLeft,
  Home,
  Download,
  Printer,
  Package,
  Truck,
  MapPin,
  Calendar,
  Search,
  QrCode,
  FileText,
  Mail,
  RotateCcw
} from "lucide-react";
import { toast } from "sonner";

// Sample label data
const SAMPLE_LABELS = [
  {
    id: "LBL-001",
    returnId: "RET-123456",
    orderNumber: "ORD-789012",
    createdAt: "2024-01-15",
    expiresAt: "2024-02-15",
    status: "ready",
    trackingNumber: "1Z999AA10123456784",
    carrier: "UPS",
    serviceType: "Ground",
    weight: "2.5 lbs",
    dimensions: "12x8x6 inches",
    sender: {
      name: "John Doe",
      address: "123 Main St",
      city: "New York",
      state: "NY",
      zip: "10001",
      phone: "(555) 123-4567"
    },
    recipient: {
      name: "Returns Center",
      address: "456 Warehouse Ave",
      city: "Los Angeles",
      state: "CA",
      zip: "90001",
      phone: "(800) 555-0100"
    }
  },
  {
    id: "LBL-002",
    returnId: "RET-789012",
    orderNumber: "ORD-345678",
    createdAt: "2024-01-10",
    expiresAt: "2024-02-10",
    status: "used",
    trackingNumber: "1Z999AA10987654321",
    carrier: "FedEx",
    serviceType: "Express",
    weight: "1.2 lbs",
    dimensions: "10x6x4 inches",
    sender: {
      name: "Jane Smith",
      address: "789 Oak Rd",
      city: "Chicago",
      state: "IL",
      zip: "60601",
      phone: "(555) 987-6543"
    },
    recipient: {
      name: "Returns Center",
      address: "456 Warehouse Ave",
      city: "Los Angeles",
      state: "CA",
      zip: "90001",
      phone: "(800) 555-0100"
    }
  }
];

export default function LabelsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [labels, setLabels] = useState(SAMPLE_LABELS);
  const [selectedLabel, setSelectedLabel] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = () => {
    if (!searchTerm) {
      setLabels(SAMPLE_LABELS);
      return;
    }

    const filtered = SAMPLE_LABELS.filter(label =>
      label.returnId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      label.orderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      label.trackingNumber.toLowerCase().includes(searchTerm.toLowerCase())
    );

    setLabels(filtered);
  };

  const handlePrintLabel = (label: any) => {
    setLoading(true);
    setTimeout(() => {
      window.print();
      toast.success("Label sent to printer");
      setLoading(false);
    }, 1000);
  };

  const handleDownloadLabel = (label: any) => {
    toast.success("Label downloaded as PDF");
  };

  const handleEmailLabel = (label: any) => {
    toast.success("Label sent to your email");
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ready": return "bg-green-500";
      case "used": return "bg-gray-500";
      case "expired": return "bg-red-500";
      default: return "bg-gray-500";
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
        <div className="max-w-6xl mx-auto">
          {/* Back Button */}
          <Link href="/" className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-6">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Portal
          </Link>

          {/* Page Title */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Return Labels</h1>
            <p className="text-gray-600">Print or download your return shipping labels</p>
          </div>

          {/* Search Bar */}
          <Card className="mb-8">
            <CardContent className="pt-6">
              <div className="flex gap-4">
                <Input
                  placeholder="Search by return ID, order number, or tracking number..."
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

          {/* Labels Grid */}
          <div className="grid md:grid-cols-2 gap-6 mb-8">
            {labels.map((label) => (
              <Card key={label.id} className="hover:shadow-lg transition-shadow">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">Label #{label.id}</CardTitle>
                      <CardDescription>Return #{label.returnId}</CardDescription>
                    </div>
                    <Badge className={`${getStatusColor(label.status)} text-white`}>
                      {label.status.toUpperCase()}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Label Info */}
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600">Carrier</p>
                      <p className="font-medium">{label.carrier}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Service</p>
                      <p className="font-medium">{label.serviceType}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Created</p>
                      <p className="font-medium">{label.createdAt}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Expires</p>
                      <p className="font-medium">{label.expiresAt}</p>
                    </div>
                  </div>

                  {/* Tracking Number */}
                  <div className="bg-gray-50 p-3 rounded-md">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-gray-600 mb-1">Tracking Number</p>
                        <p className="font-mono text-sm font-medium">{label.trackingNumber}</p>
                      </div>
                      <QrCode className="h-10 w-10 text-gray-400" />
                    </div>
                  </div>

                  {/* Addresses */}
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600 mb-1 flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> From
                      </p>
                      <p className="font-medium">{label.sender.name}</p>
                      <p className="text-gray-600">{label.sender.address}</p>
                      <p className="text-gray-600">{label.sender.city}, {label.sender.state} {label.sender.zip}</p>
                    </div>
                    <div>
                      <p className="text-gray-600 mb-1 flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> To
                      </p>
                      <p className="font-medium">{label.recipient.name}</p>
                      <p className="text-gray-600">{label.recipient.address}</p>
                      <p className="text-gray-600">{label.recipient.city}, {label.recipient.state} {label.recipient.zip}</p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handlePrintLabel(label)}
                      disabled={label.status === "used" || loading}
                      className="flex-1"
                    >
                      <Printer className="h-4 w-4 mr-2" />
                      Print
                    </Button>
                    <Button
                      onClick={() => handleDownloadLabel(label)}
                      variant="outline"
                      disabled={label.status === "used"}
                      className="flex-1"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </Button>
                    <Button
                      onClick={() => handleEmailLabel(label)}
                      variant="outline"
                      disabled={label.status === "used"}
                    >
                      <Mail className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Empty State */}
          {labels.length === 0 && (
            <Card className="text-center py-12">
              <CardContent>
                <Package className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                <h3 className="text-xl font-semibold mb-2">No Labels Found</h3>
                <p className="text-gray-600 mb-6">
                  {searchTerm
                    ? "Try adjusting your search criteria"
                    : "You don't have any return labels yet"}
                </p>
                <Link href="/return/new">
                  <Button>
                    Start a Return
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Info Card */}
          <Card className="mt-8 bg-blue-50 border-blue-200">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Label Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-gray-700">
              <p>• Labels are valid for 30 days from creation date</p>
              <p>• You can print labels multiple times until they are used</p>
              <p>• Labels include prepaid postage - no additional payment needed</p>
              <p>• Drop off packages at any authorized carrier location</p>
              <p>• Keep your tracking number for reference</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}