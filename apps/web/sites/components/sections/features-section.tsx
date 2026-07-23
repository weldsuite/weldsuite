"use client";

import { Truck, Shield, CreditCard, Headphones } from "lucide-react";

interface FeaturesectionProps {
  title?: string;
  features?: Array<{
    icon: string;
    title: string;
    description: string;
  }>;
  store?: any;
  settings?: any;
}

const defaultFeatures = [
  {
    icon: "truck",
    title: "Free Shipping",
    description: "On orders over $50"
  },
  {
    icon: "shield",
    title: "Secure Payment",
    description: "100% secure transactions"
  },
  {
    icon: "credit-card",
    title: "Easy Returns",
    description: "30-day return policy"
  },
  {
    icon: "headphones",
    title: "24/7 Support",
    description: "Dedicated customer service"
  }
];

const IconComponent = ({ icon }: { icon: string }) => {
  switch (icon) {
    case "truck":
      return <Truck className="h-8 w-8" />;
    case "shield":
      return <Shield className="h-8 w-8" />;
    case "credit-card":
      return <CreditCard className="h-8 w-8" />;
    case "headphones":
      return <Headphones className="h-8 w-8" />;
    default:
      return <Shield className="h-8 w-8" />;
  }
};

export default function FeaturesSection({
  title = "Why Choose Us",
  features = defaultFeatures,
  store,
  settings
}: FeaturesectionProps) {
  return (
    <section className="py-16 px-4 bg-muted/50">
      <div className="container mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">{title}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {features.map((feature, index) => (
            <div key={index} className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
                <IconComponent icon={feature.icon} />
              </div>
              <h3 className="font-semibold mb-2">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}