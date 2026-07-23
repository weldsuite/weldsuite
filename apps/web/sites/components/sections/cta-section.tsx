"use client";

import { Button } from "@weldsuite/ui/components/button";

interface CTASectionProps {
  title?: string;
  description?: string;
  primaryButtonText?: string;
  primaryButtonLink?: string;
  secondaryButtonText?: string;
  secondaryButtonLink?: string;
  backgroundColor?: string;
  store?: any;
  settings?: any;
}

export default function CTASection({
  title = "Ready to Get Started?",
  description = "Join thousands of satisfied customers today",
  primaryButtonText = "Get Started",
  primaryButtonLink = "#",
  secondaryButtonText,
  secondaryButtonLink = "#",
  backgroundColor,
  store,
  settings
}: CTASectionProps) {
  return (
    <section 
      className="py-16 px-4"
      style={{
        backgroundColor: backgroundColor || undefined,
      }}
    >
      <div className="container mx-auto text-center">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">{title}</h2>
        <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
          {description}
        </p>
        <div className="flex gap-4 justify-center">
          <Button size="lg" asChild>
            <a href={primaryButtonLink}>{primaryButtonText}</a>
          </Button>
          {secondaryButtonText && (
            <Button size="lg" variant="outline" asChild>
              <a href={secondaryButtonLink}>{secondaryButtonText}</a>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}