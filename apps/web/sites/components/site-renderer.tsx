"use client";

import React from 'react';
import { Website } from '@/lib/api-client';
import { SectionRenderer, PoweredByBadge } from "@weldsuite/site-components";
import Navigation from "./navigation";
import Footer from "./footer";
import Analytics from "./analytics";

interface SiteRendererProps {
  website: Website & {
    sections?: any[];
    headerSections?: any[];
    footerSections?: any[];
    navigation?: any;
  };
  store?: any;
}

export default function SiteRenderer({ website, store }: SiteRendererProps) {
  // Apply theme styles
  const themeStyles = React.useMemo(() => {
    return {
      '--primary-color': website.primaryColor || '#3b82f6',
      '--secondary-color': website.secondaryColor || '#1e40af',
      '--font-family': website.fontFamily || 'Inter, sans-serif',
    } as React.CSSProperties;
  }, [website.primaryColor, website.secondaryColor, website.fontFamily]);

  // Apply custom CSS
  React.useEffect(() => {
    if (website.customCss) {
      const style = document.createElement('style');
      style.innerHTML = website.customCss;
      style.id = 'custom-website-styles';
      document.head.appendChild(style);

      return () => {
        const existingStyle = document.getElementById('custom-website-styles');
        if (existingStyle) {
          existingStyle.remove();
        }
      };
    }
  }, [website.customCss]);

  // Apply custom JS
  React.useEffect(() => {
    if (website.customJs) {
      try {
        const script = document.createElement('script');
        script.innerHTML = website.customJs;
        script.id = 'custom-website-script';
        document.body.appendChild(script);

        return () => {
          const existingScript = document.getElementById('custom-website-script');
          if (existingScript) {
            existingScript.remove();
          }
        };
      } catch (error) {
        console.error('Error executing custom JavaScript:', error);
      }
    }
  }, [website.customJs]);

  // Apply custom head content
  React.useEffect(() => {
    if (website.customHead) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = website.customHead;
      const elements = Array.from(tempDiv.children);

      elements.forEach(element => {
        element.setAttribute('data-custom-head', 'true');
        document.head.appendChild(element);
      });

      return () => {
        document.querySelectorAll('[data-custom-head="true"]').forEach(element => {
          element.remove();
        });
      };
    }
  }, [website.customHead]);

  // Parse pages from website data
  const pages = (website as any).websitePages || [];
  const homePage = pages.find((p: any) => p.isHomePage) || pages[0];

  if (!homePage || !homePage.sections) {
    // If there are sections directly on the website, use those
    if (website.sections && website.sections.length > 0) {
      return (
        <div className="min-h-screen" style={themeStyles}>
          {website.sections.map((section: any, index: number) => (
            <SectionRenderer
              key={section.id || index}
              section={section}
              mode="live"
              store={store}
              settings={website.settings}
            />
          ))}
        </div>
      );
    }

    // Fallback to empty state
    return (
      <div className="min-h-screen flex items-center justify-center" style={themeStyles}>
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">No Content Available</h1>
          <p className="text-gray-600">This website has no pages configured yet.</p>
        </div>
      </div>
    );
  }

  // Get header, template, and footer sections
  const headerSections = (website as any).headerSections || homePage.headerSections || [];
  const templateSections = (website as any).sections || homePage.sections || [];
  const footerSections = (website as any).footerSections || homePage.footerSections || [];

  return (
    <>
      {/* Analytics tracking */}
      <Analytics website={website} />

      <div className="min-h-screen flex flex-col" style={themeStyles}>
        {/* Header Sections (Navigation, Announcement Bar, etc) */}
        {headerSections.length > 0 ? (
          <header>
            {headerSections.map((section: any, index: number) => (
              <SectionRenderer
                key={section.id || `header-${index}`}
                section={section}
                mode="live"
                store={store}
                settings={website.settings}
              />
            ))}
          </header>
        ) : website.navigation && (
          <Navigation
            navigation={website.navigation}
            logo={website.logo}
            siteName={website.name}
          />
        )}

        {/* Template Sections (Main content) */}
        <main className="flex-grow">
          {templateSections.map((section: any, index: number) => (
            <SectionRenderer
              key={section.id || `template-${index}`}
              section={section}
              mode="live"
              store={store}
              settings={website.settings}
            />
          ))}
        </main>

        {/* Footer Sections */}
        {footerSections.length > 0 ? (
          <footer>
            {footerSections.map((section: any, index: number) => (
              <SectionRenderer
                key={section.id || `footer-${index}`}
                section={section}
                mode="live"
                store={store}
                settings={website.settings}
              />
            ))}
          </footer>
        ) : (
          <Footer website={website} />
        )}

        {/* Powered by WeldCommerce badge */}
        <PoweredByBadge variant="footer" />
      </div>

      {/* Apply global styles */}
      <style jsx global>{`
        body {
          font-family: var(--font-family);
          color: var(--text-color, #111827);
          background-color: var(--background-color, #ffffff);
        }

        a {
          color: var(--primary-color);
        }

        a:hover {
          color: var(--secondary-color);
        }

        .btn-primary {
          background-color: var(--primary-color);
          color: white;
        }

        .btn-primary:hover {
          background-color: var(--secondary-color);
        }
      `}</style>
    </>
  );
}