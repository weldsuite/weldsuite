"use client";

import { Button } from "@weldsuite/ui/components/button";
import { ShoppingCart, Menu } from "lucide-react";
import Image from "next/image";

interface HeaderSectionProps {
  title?: string;
  links?: string[];
  store?: any;
  settings?: any;
}

export default function HeaderSection({ 
  title,
  links = ["Home", "Products", "About", "Contact"],
  store,
  settings
}: HeaderSectionProps) {
  const displayTitle = title || store?.name || "Your Store";
  const logo = store?.logo;

  return (
    <header className="border-b">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              {logo && (
                <Image
                  src={logo}
                  alt={displayTitle}
                  width={32}
                  height={32}
                  className="rounded"
                />
              )}
              <h1 className="text-2xl font-bold">{displayTitle}</h1>
            </div>
            
            <nav className="hidden md:flex items-center gap-6">
              {links.map((link) => (
                <a
                  key={link}
                  href={`#${link.toLowerCase()}`}
                  className="text-sm font-medium hover:text-primary transition-colors"
                >
                  {link}
                </a>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm">
              <ShoppingCart className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="sm" className="md:hidden">
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}