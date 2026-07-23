import { notFound } from "next/navigation";
import { getWebsiteByDomain, trackPageView, getProducts, getCollections } from "@/lib/api-client";
import SiteRenderer from "@/components/site-renderer";

interface PageProps {
  params: Promise<{ domain: string; slug: string[] }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DynamicPage({ params, searchParams }: PageProps) {
  const { domain, slug } = await params;
  const pagePath = `/${slug.join('/')}`;

  // Fetch website data server-side using Server Action
  const website = await getWebsiteByDomain(domain);

  if (!website) {
    console.log(`[Page] No website found for domain: ${domain}`);
    notFound();
  }

  // Only show published websites
  if (!website.isPublished || website.status !== 'published') {
    console.log(`[Page] Website not published: ${domain}`);
    notFound();
  }

  // Find the page by slug in the website data
  const pages = website.websitePages as any[];
  const currentPage = pages?.find((p: any) => p.slug === pagePath);

  if (!currentPage) {
    console.log(`[Page] Page not found for slug: ${pagePath}`);
    notFound();
  }

  // Extract product and collection IDs from page sections
  const extractResourceIds = (page: any) => {
    const productIds = new Set<string>();
    const collectionIds = new Set<string>();

    const allSections = [
      ...(page.sections || []),
      ...(page.headerSections || []),
      ...(page.footerSections || [])
    ];

    allSections.forEach((section: any) => {
      // Check for productIds in section props
      if (section.props?.productIds) {
        section.props.productIds.forEach((id: string) => productIds.add(id));
      }
      // Check for collectionIds in section props
      if (section.props?.collectionIds) {
        section.props.collectionIds.forEach((id: string) => collectionIds.add(id));
      }
      // Check for single productId or collectionId
      if (section.props?.productId) {
        productIds.add(section.props.productId);
      }
      if (section.props?.collectionId) {
        collectionIds.add(section.props.collectionId);
      }
    });

    return { productIds: Array.from(productIds), collectionIds: Array.from(collectionIds) };
  };

  const { productIds, collectionIds } = extractResourceIds(currentPage);

  // Fetch store data (products and collections) in parallel
  const [products, collections] = await Promise.all([
    getProducts(domain, productIds.length > 0 ? productIds : undefined, productIds.length === 0 ? 50 : undefined),
    getCollections(domain, collectionIds.length > 0 ? collectionIds : undefined, collectionIds.length === 0 ? 20 : undefined)
  ]);

  // Build store object
  const store = {
    products: products || [],
    collections: collections || []
  };

  // Track page view (fire and forget)
  if (website.id) {
    trackPageView(website.id, pagePath).catch(() => {
      // Silently fail analytics
    });
  }

  // Create a website object with the current page
  const websiteWithPage = {
    ...website,
    sections: currentPage.sections || [],
    headerSections: currentPage.headerSections || [],
    footerSections: currentPage.footerSections || [],
  };

  return <SiteRenderer website={websiteWithPage} store={store} />;
}

// Generate metadata for SEO (Server-side)
export async function generateMetadata({ params }: PageProps) {
  const { domain, slug } = await params;
  const pagePath = `/${slug.join('/')}`;
  const website = await getWebsiteByDomain(domain);

  if (!website) {
    return {
      title: 'Site Not Found',
      description: 'The requested site could not be found.'
    };
  }

  // Find the page
  const pages = website.websitePages as any[];
  const currentPage = pages?.find((p: any) => p.slug === pagePath);

  if (!currentPage) {
    return {
      title: 'Page Not Found',
      description: 'The requested page could not be found.'
    };
  }

  return {
    title: `${currentPage.name} | ${website.name}` || website.seoTitle || 'Website',
    description: website.seoDescription || website.description || 'Built with WeldCommerce',
    keywords: website.seoKeywords || '',
    openGraph: {
      title: `${currentPage.name} | ${website.name}`,
      description: website.seoDescription || website.description,
      images: website.ogImage ? [website.ogImage] : [],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${currentPage.name} | ${website.name}`,
      description: website.seoDescription || website.description,
      images: website.ogImage ? [website.ogImage] : [],
    },
    icons: {
      icon: website.favicon || '/favicon.ico',
    },
    other: {
      ...(website.googleAnalytics && {
        'google-site-verification': website.googleAnalytics,
      }),
    },
  };
}

// Optionally implement ISR (Incremental Static Regeneration)
export const revalidate = 60; // Revalidate every 60 seconds
