"use client";

import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weldsuite/ui/components/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@weldsuite/ui/components/accordion";
import {
  ArrowLeft,
  Home,
  FileText,
  Clock,
  Package,
  DollarSign,
  Shield,
  AlertCircle,
  CheckCircle,
  XCircle,
  Info,
  RotateCcw,
  Truck,
  CreditCard,
  Calendar
} from "lucide-react";

export default function PoliciesPage() {
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
            <h1 className="text-3xl font-bold mb-2">Return Policies</h1>
            <p className="text-gray-600">Everything you need to know about our return process</p>
          </div>

          {/* Policy Tabs */}
          <Tabs defaultValue="general" className="mb-8">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="eligibility">Eligibility</TabsTrigger>
              <TabsTrigger value="process">Process</TabsTrigger>
              <TabsTrigger value="refunds">Refunds</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5 text-blue-600" />
                    General Return Policy
                  </CardTitle>
                </CardHeader>
                <CardContent className="prose prose-gray max-w-none">
                  <p className="text-gray-700">
                    We want you to be completely satisfied with your purchase. If you're not happy with your order,
                    we offer a hassle-free return process within our return window.
                  </p>

                  <div className="grid md:grid-cols-3 gap-4 mt-6">
                    <Card className="border-green-200 bg-green-50">
                      <CardContent className="pt-6 text-center">
                        <Calendar className="h-8 w-8 text-green-600 mx-auto mb-2" />
                        <h4 className="font-semibold mb-1">30-Day Returns</h4>
                        <p className="text-sm text-gray-600">Most items can be returned within 30 days</p>
                      </CardContent>
                    </Card>
                    <Card className="border-blue-200 bg-blue-50">
                      <CardContent className="pt-6 text-center">
                        <Truck className="h-8 w-8 text-blue-600 mx-auto mb-2" />
                        <h4 className="font-semibold mb-1">Free Returns</h4>
                        <p className="text-sm text-gray-600">Prepaid shipping labels provided</p>
                      </CardContent>
                    </Card>
                    <Card className="border-purple-200 bg-purple-50">
                      <CardContent className="pt-6 text-center">
                        <CreditCard className="h-8 w-8 text-purple-600 mx-auto mb-2" />
                        <h4 className="font-semibold mb-1">Full Refunds</h4>
                        <p className="text-sm text-gray-600">100% refund on eligible items</p>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="mt-8 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex gap-3">
                      <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                      <div>
                        <h4 className="font-semibold text-yellow-900 mb-1">Extended Holiday Returns</h4>
                        <p className="text-sm text-yellow-800">
                          Items purchased between November 1 and December 31 can be returned until January 31 of the following year.
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="eligibility" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    Eligible for Return
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    <li className="flex items-start gap-3">
                      <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Unused and Unopened Items</p>
                        <p className="text-sm text-gray-600">Products in original packaging with all tags attached</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Defective or Damaged Products</p>
                        <p className="text-sm text-gray-600">Items that arrived damaged or don't work as described</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Wrong Item Received</p>
                        <p className="text-sm text-gray-600">If you received a different item than what you ordered</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Change of Mind</p>
                        <p className="text-sm text-gray-600">Most items can be returned if you simply changed your mind</p>
                      </div>
                    </li>
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <XCircle className="h-5 w-5 text-red-600" />
                    Not Eligible for Return
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    <li className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Personalized or Custom Items</p>
                        <p className="text-sm text-gray-600">Products made to order or personalized for you</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Perishable Goods</p>
                        <p className="text-sm text-gray-600">Food, flowers, and other perishable items</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Digital Products</p>
                        <p className="text-sm text-gray-600">Downloaded software, digital subscriptions, and e-books</p>
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                      <div>
                        <p className="font-medium">Health & Personal Care</p>
                        <p className="text-sm text-gray-600">Items that can't be resold for health and safety reasons</p>
                      </div>
                    </li>
                  </ul>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="process" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Return Process Steps</CardTitle>
                </CardHeader>
                <CardContent>
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="step1">
                      <AccordionTrigger>
                        <span className="flex items-center gap-3">
                          <span className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-full text-sm font-bold">
                            1
                          </span>
                          Initiate Your Return
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pl-11">
                        <p className="text-gray-700">
                          Start by entering your order number on our returns portal. Select the items you wish to return
                          and provide a reason for the return. This helps us improve our products and services.
                        </p>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="step2">
                      <AccordionTrigger>
                        <span className="flex items-center gap-3">
                          <span className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-full text-sm font-bold">
                            2
                          </span>
                          Get Your Shipping Label
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pl-11">
                        <p className="text-gray-700">
                          Once approved, you'll receive a prepaid shipping label via email. Print this label at home or
                          show the QR code at a shipping location to have them print it for you.
                        </p>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="step3">
                      <AccordionTrigger>
                        <span className="flex items-center gap-3">
                          <span className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-full text-sm font-bold">
                            3
                          </span>
                          Pack Your Items
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pl-11">
                        <p className="text-gray-700">
                          Securely pack the items in their original packaging if available. Include all accessories,
                          manuals, and parts. Attach the shipping label to the outside of the package.
                        </p>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="step4">
                      <AccordionTrigger>
                        <span className="flex items-center gap-3">
                          <span className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-full text-sm font-bold">
                            4
                          </span>
                          Ship Your Return
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pl-11">
                        <p className="text-gray-700">
                          Drop off your package at any authorized shipping location or schedule a pickup. Keep your
                          tracking number to monitor the return progress.
                        </p>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="step5">
                      <AccordionTrigger>
                        <span className="flex items-center gap-3">
                          <span className="flex items-center justify-center w-8 h-8 bg-blue-600 text-white rounded-full text-sm font-bold">
                            5
                          </span>
                          Receive Your Refund
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pl-11">
                        <p className="text-gray-700">
                          Once we receive and inspect your return, we'll process your refund. You'll receive an email
                          confirmation and the refund will appear in your account within 3-5 business days.
                        </p>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="refunds" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-green-600" />
                    Refund Information
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <h4 className="font-semibold mb-3">Refund Timeline</h4>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-gray-400" />
                        <div>
                          <p className="font-medium">1-2 Business Days</p>
                          <p className="text-sm text-gray-600">Return inspection and processing</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-gray-400" />
                        <div>
                          <p className="font-medium">3-5 Business Days</p>
                          <p className="text-sm text-gray-600">Refund appears in your account</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-gray-400" />
                        <div>
                          <p className="font-medium">5-10 Business Days</p>
                          <p className="text-sm text-gray-600">Bank statement reflects the refund</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-semibold mb-3">Refund Methods</h4>
                    <ul className="space-y-2">
                      <li className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <span>Original payment method (credit/debit card)</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <span>Store credit (processed immediately)</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <span>Gift card balance (if originally paid with gift card)</span>
                      </li>
                    </ul>
                  </div>

                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex gap-3">
                      <Info className="h-5 w-5 text-blue-600 mt-0.5" />
                      <div>
                        <h4 className="font-semibold text-blue-900 mb-1">Partial Refunds</h4>
                        <p className="text-sm text-blue-800">
                          In some cases, only partial refunds are granted (e.g., items with obvious signs of use,
                          missing parts, or not in original condition).
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-semibold mb-3">Shipping Costs</h4>
                    <ul className="space-y-2 text-gray-700">
                      <li>• Original shipping costs are non-refundable unless the return is due to our error</li>
                      <li>• Return shipping is free with our prepaid labels</li>
                      <li>• Express or expedited shipping fees are non-refundable</li>
                      <li>• International shipping duties and taxes are not refunded</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Contact Card */}
          <Card className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
            <CardHeader>
              <CardTitle>Need Help?</CardTitle>
              <CardDescription>Our customer service team is here to assist you</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-3 gap-4">
                <Button variant="outline" className="justify-start">
                  <Shield className="h-4 w-4 mr-2" />
                  Contact Support
                </Button>
                <Button variant="outline" className="justify-start">
                  <FileText className="h-4 w-4 mr-2" />
                  View FAQs
                </Button>
                <Button variant="outline" className="justify-start">
                  <Package className="h-4 w-4 mr-2" />
                  Track Return
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}