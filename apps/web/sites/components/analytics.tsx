"use client";

import Script from 'next/script';
import { Website } from '@/lib/api-client';

interface AnalyticsProps {
  website: Website;
}

export default function Analytics({ website }: AnalyticsProps) {
  return (
    <>
      {/* Google Analytics */}
      {website.googleAnalytics && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${website.googleAnalytics}`}
            strategy="afterInteractive"
          />
          <Script id="google-analytics" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${website.googleAnalytics}');
            `}
          </Script>
        </>
      )}

      {/* Facebook Pixel */}
      {website.facebookPixel && (
        <Script id="facebook-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${website.facebookPixel}');
            fbq('track', 'PageView');
          `}
        </Script>
      )}

      {/* Custom Analytics Scripts */}
      {website.analytics && (website.analytics as any).customScripts && (
        <Script id="custom-analytics" strategy="afterInteractive">
          {(website.analytics as any).customScripts}
        </Script>
      )}
    </>
  );
}