"use client";

import { Facebook, Twitter, Instagram, Mail } from "lucide-react";

interface FooterSectionProps {
  companyName?: string;
  links?: Array<{
    title: string;
    items: string[];
  }>;
  store?: any;
  settings?: any;
}

const defaultLinks = [
  {
    title: "Company",
    items: ["About Us", "Careers", "Press"]
  },
  {
    title: "Support",
    items: ["Help Center", "Contact", "FAQ"]
  },
  {
    title: "Legal",
    items: ["Privacy Policy", "Terms of Service", "Cookie Policy"]
  }
];

export default function FooterSection({
  companyName,
  links = defaultLinks,
  store,
  settings
}: FooterSectionProps) {
  const displayName = companyName || store?.name || "Your Store";
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-muted/50 border-t">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <h3 className="font-bold text-lg mb-4">{displayName}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {store?.description || "Your trusted online store"}
            </p>
            <div className="flex gap-4">
              <button type="button" aria-label="Facebook" className="cursor-pointer text-muted-foreground hover:text-primary">
                <Facebook className="h-5 w-5" />
              </button>
              <button type="button" aria-label="Twitter" className="cursor-pointer text-muted-foreground hover:text-primary">
                <Twitter className="h-5 w-5" />
              </button>
              <button type="button" aria-label="Instagram" className="cursor-pointer text-muted-foreground hover:text-primary">
                <Instagram className="h-5 w-5" />
              </button>
              <button type="button" aria-label="Email" className="cursor-pointer text-muted-foreground hover:text-primary">
                <Mail className="h-5 w-5" />
              </button>
            </div>
          </div>
          
          {links.map((section, index) => (
            <div key={index}>
              <h4 className="font-semibold mb-4">{section.title}</h4>
              <ul className="space-y-2">
                {section.items.map((item) => (
                  <li key={item}>
                    <button type="button" className="cursor-pointer text-sm text-muted-foreground hover:text-primary">
                      {item}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        
        <div className="border-t mt-8 pt-8 text-center text-sm text-muted-foreground">
          <p>© {currentYear} {displayName}. All rights reserved.</p>
          <p className="mt-2">Powered by WeldSuite</p>
        </div>
      </div>
    </footer>
  );
}