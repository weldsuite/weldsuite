import type { ComponentType } from 'react';
import { AnnouncementBar } from './announcement-bar';
import { CategoryList } from './category-list';
import { ContactForm } from './contact-form';
import { Faq } from './faq';
import { FeaturedProducts } from './featured-products';
import { Footer } from './footer';
import { Header } from './header';
import { Hero } from './hero';
import { ImageBanner } from './image-banner';
import { ImageWithText } from './image-with-text';
import { MainCart } from './main-cart';
import { MainCategory } from './main-category';
import { MainNotFound } from './main-not-found';
import { MainPage } from './main-page';
import { MainProduct } from './main-product';
import { MainSearch } from './main-search';
import { Multicolumn } from './multicolumn';
import { RelatedProducts } from './related-products';
import { RichTextSection } from './rich-text';
import { Testimonials } from './testimonials';
import type { SectionProps } from './types';
import { Video } from './video';

/** The component of every section type in `SECTION_CATALOG` (catalog.test.ts keeps them in step). */
export const SECTION_COMPONENTS: Record<string, ComponentType<SectionProps>> = {
  'announcement-bar': AnnouncementBar,
  header: Header,
  footer: Footer,
  'main-product': MainProduct,
  'main-category': MainCategory,
  'main-search': MainSearch,
  'main-cart': MainCart,
  'main-page': MainPage,
  'main-not-found': MainNotFound,
  hero: Hero,
  'image-banner': ImageBanner,
  'featured-products': FeaturedProducts,
  'related-products': RelatedProducts,
  'category-list': CategoryList,
  'image-with-text': ImageWithText,
  'rich-text': RichTextSection,
  multicolumn: Multicolumn,
  testimonials: Testimonials,
  faq: Faq,
  video: Video,
  'contact-form': ContactForm,
};

export type { SectionProps } from './types';
