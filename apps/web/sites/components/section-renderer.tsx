"use client";

import HeaderSection from "./sections/header-section";
import HeroSection from "./sections/hero-section";
import ProductGridSection from "./sections/product-grid-section";
import FeaturesSection from "./sections/features-section";
import TestimonialsSection from "./sections/testimonials-section";
import NewsletterSection from "./sections/newsletter-section";
import FooterSection from "./sections/footer-section";
import TextSection from "./sections/text-section";
import ImageSection from "./sections/image-section";
import VideoSection from "./sections/video-section";
import CTASection from "./sections/cta-section";

interface SectionRendererProps {
  section: {
    id: string;
    type: string;
    props: Record<string, any>;
    elements?: any[];
  };
  store?: any;
  settings: Record<string, any>;
}

export default function SectionRenderer({ section, store, settings }: SectionRendererProps) {
  const commonProps = {
    ...section.props,
    store,
    settings,
    elements: section.elements,
  };

  switch (section.type) {
    case 'header':
      return <HeaderSection {...commonProps} />;
    case 'hero':
      return <HeroSection {...commonProps} />;
    case 'productGrid':
      return <ProductGridSection {...commonProps} />;
    case 'features':
      return <FeaturesSection {...commonProps} />;
    case 'testimonials':
      return <TestimonialsSection {...commonProps} />;
    case 'newsletter':
      return <NewsletterSection {...commonProps} />;
    case 'footer':
      return <FooterSection {...commonProps} />;
    case 'text':
      return <TextSection {...commonProps} />;
    case 'image':
      return <ImageSection {...commonProps} />;
    case 'video':
      return <VideoSection {...commonProps} />;
    case 'cta':
      return <CTASection {...commonProps} />;
    default:
      return (
        <div className="py-8 px-4 text-center text-muted-foreground">
          Unknown section type: {section.type}
        </div>
      );
  }
}