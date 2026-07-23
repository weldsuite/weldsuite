import { notFound } from "next/navigation";
import { getWebsiteByDomain, trackPageView, getProducts, getCollections, type Website } from "@/lib/api-client";
import SiteRenderer from "@/components/site-renderer";

interface PageProps {
  params: Promise<{ domain: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DomainPage({ params, searchParams }: PageProps) {
  const { domain } = await params;

  // Fetch website data server-side using Server Action
  const website = await getWebsiteByDomain(domain);
  console.log(`[Page] Fetched website for domain: ${domain}`, website);

  if (!website) {
    console.log(`[Page] No website found for domain: ${domain}`);
    notFound();
  }

  // Only show published websites
  if (!website.isPublished || website.status !== 'published') {
    console.log(`[Page] Website not published: ${domain}`);
    notFound();
  }

  // Extract product and collection IDs from sections if they exist
  const extractResourceIds = (sections: any[]) => {
    const productIds = new Set<string>();
    const collectionIds = new Set<string>();

    sections?.forEach((section: any) => {
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

  // Find the home page from the websitePages array
  const pages = website.websitePages as any[];
  console.log(pages)
  const homePage = pages?.find((p: any) => p.isHomePage) || pages?.[0];

  if (!homePage) {
    console.log(`[Page] No home page found for domain: ${domain}`);
    notFound();
  }

  // Extract resource IDs from home page sections
  const extractResourceIdsFromPage = (page: any) => {
    const productIds = new Set<string>();
    const collectionIds = new Set<string>();

    const allSections = [
      ...(page.sections || []),
      ...(page.headerSections || []),
      ...(page.footerSections || [])
    ];

    allSections.forEach((section: any) => {
      if (section.props?.productIds) {
        section.props.productIds.forEach((id: string) => productIds.add(id));
      }
      if (section.props?.collectionIds) {
        section.props.collectionIds.forEach((id: string) => collectionIds.add(id));
      }
      if (section.props?.productId) {
        productIds.add(section.props.productId);
      }
      if (section.props?.collectionId) {
        collectionIds.add(section.props.collectionId);
      }
    });

    return { productIds: Array.from(productIds), collectionIds: Array.from(collectionIds) };
  };

  const { productIds, collectionIds } = extractResourceIdsFromPage(homePage);

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
    trackPageView(website.id, '/').catch(() => {
      // Silently fail analytics
    });
  }

  // Create a website object with the home page sections
  const websiteWithHomePage = {
    ...website,
    sections: homePage.sections || [],
    headerSections: homePage.headerSections || [],
    footerSections: homePage.footerSections || [],
  };

  return <SiteRenderer website={websiteWithHomePage} store={store} />;
}

// Generate metadata for SEO (Server-side)
export async function generateMetadata({ params }: PageProps) {
  const { domain } = await params;
  const website = await getWebsiteByDomain(domain);

  if (!website) {
    return {
      title: 'Site Not Found',
      description: 'The requested site could not be found.'
    };
  }

  return {
    title: website.seoTitle || website.name || 'Website',
    description: website.seoDescription || website.description || 'Built with WeldCommerce',
    keywords: website.seoKeywords || '',
    openGraph: {
      title: website.seoTitle || website.name,
      description: website.seoDescription || website.description,
      images: website.ogImage ? [website.ogImage] : [],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: website.seoTitle || website.name,
      description: website.seoDescription || website.description,
      images: website.ogImage ? [website.ogImage] : [],
    },
    icons: {
      icon: website.favicon || '/favicon.ico',
    },
    other: {
      // Add Google Analytics if configured
      ...(website.googleAnalytics && {
        'google-site-verification': website.googleAnalytics,
      }),
    },
  };
}

// Optionally implement ISR (Incremental Static Regeneration) for better performance
export const revalidate = 60; // Revalidate every 60 seconds