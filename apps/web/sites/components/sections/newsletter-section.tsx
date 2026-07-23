"use client";

import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";

interface NewsletterSectionProps {
  title?: string;
  description?: string;
  buttonText?: string;
  placeholder?: string;
  store?: any;
  settings?: any;
}

export default function NewsletterSection({
  title = "Stay Updated",
  description = "Subscribe to our newsletter and get exclusive offers",
  buttonText = "Subscribe",
  placeholder = "Enter your email",
  store,
  settings
}: NewsletterSectionProps) {
  return (
    <section className="py-16 px-4 bg-primary/5">
      <div className="container mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold mb-4">{title}</h2>
        <p className="text-muted-foreground mb-8">{description}</p>
        <form className="flex gap-4 max-w-md mx-auto" onSubmit={(e) => e.preventDefault()}>
          <Input
            type="email"
            placeholder={placeholder}
            className="flex-1"
            required
          />
          <Button type="submit">{buttonText}</Button>
        </form>
      </div>
    </section>
  );
}