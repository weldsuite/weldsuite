"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Textarea } from "@weldsuite/ui/components/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@weldsuite/ui/components/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weldsuite/ui/components/tabs";
import {
  ArrowLeft,
  Home,
  Search,
  HelpCircle,
  Package,
  Truck,
  CreditCard,
  Clock,
  Shield,
  Mail,
  Phone,
  MessageCircle,
  FileText,
  AlertCircle,
  ChevronRight,
  RotateCcw,
  Send
} from "lucide-react";
import { toast } from "sonner";

const FAQ_CATEGORIES = {
  general: {
    title: "General Questions",
    icon: HelpCircle,
    questions: [
      {
        question: "How long do I have to return an item?",
        answer: "Most items can be returned within 30 days of delivery. During the holiday season (Nov 1 - Dec 31), the return window extends to January 31 of the following year."
      },
      {
        question: "Is there a fee for returning items?",
        answer: "No, we provide free prepaid shipping labels for all returns. Simply print the label and drop off your package at any authorized shipping location."
      },
      {
        question: "Can I return items purchased with a gift card?",
        answer: "Yes, items purchased with a gift card can be returned. The refund will be issued back to a gift card, which will be emailed to you."
      },
      {
        question: "What items cannot be returned?",
        answer: "Personalized items, perishable goods, digital products, and health/personal care items cannot be returned for hygiene and safety reasons."
      }
    ]
  },
  shipping: {
    title: "Shipping & Labels",
    icon: Truck,
    questions: [
      {
        question: "How do I get a return shipping label?",
        answer: "After initiating your return online, you'll receive a prepaid shipping label via email. You can print it at home or show the QR code at a shipping location."
      },
      {
        question: "Can I use my own shipping method?",
        answer: "We recommend using our prepaid labels for tracking purposes. If you use your own shipping method, you'll be responsible for shipping costs and the package must be trackable."
      },
      {
        question: "Where can I drop off my return package?",
        answer: "You can drop off your package at any UPS Store, FedEx Office, USPS Post Office, or authorized shipping location. You can also schedule a pickup."
      },
      {
        question: "How long is the return label valid?",
        answer: "Return shipping labels are valid for 30 days from the date of creation. If your label expires, contact customer service for a new one."
      }
    ]
  },
  refunds: {
    title: "Refunds & Credits",
    icon: CreditCard,
    questions: [
      {
        question: "How long does it take to receive my refund?",
        answer: "Once we receive and inspect your return (1-2 business days), your refund will be processed. It typically appears in your account within 3-5 business days."
      },
      {
        question: "Can I get store credit instead of a refund?",
        answer: "Yes, you can choose to receive store credit which is processed immediately and never expires. Store credit often includes a bonus amount."
      },
      {
        question: "Will I be refunded for shipping costs?",
        answer: "Original shipping costs are only refunded if the return is due to our error (wrong item, defective product). Return shipping with our label is always free."
      },
      {
        question: "What if I only receive a partial refund?",
        answer: "Partial refunds may be issued for items returned with obvious signs of use, missing parts, or not in original condition. You'll receive an email explaining the adjustment."
      }
    ]
  },
  process: {
    title: "Return Process",
    icon: Package,
    questions: [
      {
        question: "How do I start a return?",
        answer: "Visit our returns portal, enter your order number, select the items you want to return, provide a reason, and follow the prompts to get your shipping label."
      },
      {
        question: "Can I exchange an item instead of returning it?",
        answer: "Yes, you can select 'Exchange' during the return process. We'll ship your replacement item once we receive your return, or immediately for Prime members."
      },
      {
        question: "What should I include in the return package?",
        answer: "Include all original items, accessories, manuals, and packaging. Don't forget to include the return authorization slip if provided."
      },
      {
        question: "Can I return multiple orders in one package?",
        answer: "Each return should be processed separately with its own label to ensure proper tracking and faster processing."
      }
    ]
  }
};

const CONTACT_OPTIONS = [
  {
    icon: Phone,
    title: "Phone Support",
    description: "Talk to a representative",
    action: "1-800-RETURNS",
    availability: "Mon-Fri 9am-6pm EST"
  },
  {
    icon: Mail,
    title: "Email Support",
    description: "Get help via email",
    action: "support@returns.com",
    availability: "Response within 24 hours"
  },
  {
    icon: MessageCircle,
    title: "Live Chat",
    description: "Chat with our team",
    action: "Start Chat",
    availability: "Available 24/7"
  }
];

export default function HelpPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("general");
  const [contactForm, setContactForm] = useState({
    name: "",
    email: "",
    orderNumber: "",
    subject: "",
    message: ""
  });

  const handleSearch = (term: string) => {
    setSearchTerm(term);
  };

  const handleContactSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    toast.success("Your message has been sent! We'll respond within 24 hours.");
    setContactForm({
      name: "",
      email: "",
      orderNumber: "",
      subject: "",
      message: ""
    });
  };

  const filteredQuestions = searchTerm
    ? Object.values(FAQ_CATEGORIES).flatMap(cat =>
        cat.questions.filter(q =>
          q.question.toLowerCase().includes(searchTerm.toLowerCase()) ||
          q.answer.toLowerCase().includes(searchTerm.toLowerCase())
        )
      )
    : FAQ_CATEGORIES[selectedCategory as keyof typeof FAQ_CATEGORIES].questions;

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
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold mb-2">Help Center</h1>
            <p className="text-gray-600 text-lg">Find answers to your questions about returns and exchanges</p>
          </div>

          {/* Search Bar */}
          <Card className="mb-8">
            <CardContent className="pt-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  placeholder="Search for answers..."
                  value={searchTerm}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="pl-10 pr-4 py-2 text-lg"
                />
              </div>
            </CardContent>
          </Card>

          {/* Quick Links */}
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            {Object.entries(FAQ_CATEGORIES).map(([key, category]) => {
              const Icon = category.icon;
              return (
                <Card
                  key={key}
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    selectedCategory === key ? 'ring-2 ring-blue-600' : ''
                  }`}
                  onClick={() => {
                    setSelectedCategory(key);
                    setSearchTerm("");
                  }}
                >
                  <CardContent className="pt-6 text-center">
                    <Icon className={`h-8 w-8 mx-auto mb-2 ${
                      selectedCategory === key ? 'text-blue-600' : 'text-gray-600'
                    }`} />
                    <p className="text-sm font-medium">{category.title}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Tabs defaultValue="faq" className="mb-8">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="faq">Frequently Asked Questions</TabsTrigger>
              <TabsTrigger value="contact">Contact Support</TabsTrigger>
            </TabsList>

            <TabsContent value="faq">
              {/* FAQ Section */}
              <Card>
                <CardHeader>
                  <CardTitle>
                    {searchTerm
                      ? `Search Results (${filteredQuestions.length})`
                      : FAQ_CATEGORIES[selectedCategory as keyof typeof FAQ_CATEGORIES].title
                    }
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {filteredQuestions.length > 0 ? (
                    <Accordion type="single" collapsible className="w-full">
                      {filteredQuestions.map((item, index) => (
                        <AccordionItem key={index} value={`item-${index}`}>
                          <AccordionTrigger className="text-left">
                            {item.question}
                          </AccordionTrigger>
                          <AccordionContent>
                            <p className="text-gray-700">{item.answer}</p>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  ) : (
                    <div className="text-center py-8">
                      <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-3" />
                      <p className="text-gray-600">No results found for "{searchTerm}"</p>
                      <p className="text-sm text-gray-500 mt-1">Try searching with different keywords</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="contact" className="space-y-6">
              {/* Contact Options */}
              <div className="grid md:grid-cols-3 gap-4 mb-6">
                {CONTACT_OPTIONS.map((option, index) => (
                  <Card key={index} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-6 text-center">
                      <option.icon className="h-10 w-10 mx-auto mb-3 text-blue-600" />
                      <h3 className="font-semibold mb-1">{option.title}</h3>
                      <p className="text-sm text-gray-600 mb-2">{option.description}</p>
                      <p className="font-medium text-blue-600 mb-1">{option.action}</p>
                      <p className="text-xs text-gray-500">{option.availability}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Contact Form */}
              <Card>
                <CardHeader>
                  <CardTitle>Send Us a Message</CardTitle>
                  <CardDescription>
                    Can't find what you're looking for? Send us a message and we'll get back to you within 24 hours.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleContactSubmit} className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">Name</label>
                        <Input
                          required
                          value={contactForm.name}
                          onChange={(e) => setContactForm({...contactForm, name: e.target.value})}
                          placeholder="Your name"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">Email</label>
                        <Input
                          required
                          type="email"
                          value={contactForm.email}
                          onChange={(e) => setContactForm({...contactForm, email: e.target.value})}
                          placeholder="your@email.com"
                        />
                      </div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium mb-1 block">Order Number (Optional)</label>
                        <Input
                          value={contactForm.orderNumber}
                          onChange={(e) => setContactForm({...contactForm, orderNumber: e.target.value})}
                          placeholder="ORD-123456"
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium mb-1 block">Subject</label>
                        <Input
                          required
                          value={contactForm.subject}
                          onChange={(e) => setContactForm({...contactForm, subject: e.target.value})}
                          placeholder="What can we help with?"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">Message</label>
                      <Textarea
                        required
                        value={contactForm.message}
                        onChange={(e) => setContactForm({...contactForm, message: e.target.value})}
                        placeholder="Please describe your issue in detail..."
                        rows={5}
                      />
                    </div>
                    <Button type="submit" className="w-full">
                      <Send className="h-4 w-4 mr-2" />
                      Send Message
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Additional Resources */}
          <Card className="bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200">
            <CardHeader>
              <CardTitle>Additional Resources</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-3 gap-4">
                <Link href="/policies">
                  <Button variant="outline" className="w-full justify-between">
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Return Policies
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/track">
                  <Button variant="outline" className="w-full justify-between">
                    <span className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Track Return
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/return/new">
                  <Button variant="outline" className="w-full justify-between">
                    <span className="flex items-center gap-2">
                      <RotateCcw className="h-4 w-4" />
                      Start Return
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}