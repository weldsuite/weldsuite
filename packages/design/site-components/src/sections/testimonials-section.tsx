"use client";

import { Card, CardContent } from "@weldsuite/ui/components/card";
import { Star } from "lucide-react";

interface TestimonialsSectionProps {
  title?: string;
  testimonials?: Array<{
    name: string;
    role?: string;
    content: string;
    rating?: number;
  }>;
  store?: any;
  settings?: any;
}

const defaultTestimonials = [
  {
    name: "Sarah Johnson",
    role: "Verified Buyer",
    content: "Amazing quality products and super fast delivery. Couldn't be happier!",
    rating: 5
  },
  {
    name: "Mike Chen",
    role: "Regular Customer",
    content: "Best online shopping experience I've had. Will definitely order again.",
    rating: 5
  },
  {
    name: "Emily Rodriguez",
    role: "Happy Customer",
    content: "Great customer service and excellent product quality. Highly recommend!",
    rating: 5
  }
];

export default function TestimonialsSection({
  title = "What Our Customers Say",
  testimonials = defaultTestimonials,
  store,
  settings
}: TestimonialsSectionProps) {
  return (
    <section className="py-16 px-4">
      <div className="container mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">{title}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {testimonials.map((testimonial, index) => (
            <Card key={index}>
              <CardContent className="pt-6">
                <div className="flex mb-4">
                  {[...Array(testimonial.rating || 5)].map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-primary text-primary" />
                  ))}
                </div>
                <p className="text-muted-foreground mb-4">"{testimonial.content}"</p>
                <div>
                  <p className="font-semibold">{testimonial.name}</p>
                  {testimonial.role && (
                    <p className="text-sm text-muted-foreground">{testimonial.role}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}