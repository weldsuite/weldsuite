"use client";

import { Button } from "@weldsuite/ui/components/button";

interface HeroSectionProps {
  title?: string;
  subtitle?: string;
  buttonText?: string;
  backgroundImage?: string;
  store?: any;
  settings?: any;
}

export default function HeroSection({ 
  title = "Welcome to Our Store",
  subtitle = "Discover amazing products at great prices",
  buttonText = "Shop Now",
  backgroundImage,
  store,
  settings
}: HeroSectionProps) {
  return (
    <section 
      className="relative py-24 px-4 bg-gradient-to-r from-primary/10 to-secondary/10"
      style={{
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="container mx-auto text-center">
        <h2 className="text-4xl md:text-6xl font-bold mb-6">{title}</h2>
        <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
          {subtitle}
        </p>
        <Button size="lg">
          {buttonText}
        </Button>
      </div>
    </section>
  );
}