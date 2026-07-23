"use client";

import React from 'react';

export interface SectionSettings {
  // Layout
  fullWidth?: boolean;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';

  // Spacing
  paddingTop?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  paddingBottom?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  paddingLeft?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  paddingRight?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  marginTop?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  marginBottom?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

  // Colors
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;

  // Visual Effects
  backgroundImage?: string;
  backgroundSize?: 'cover' | 'contain' | 'auto';
  backgroundPosition?: string;
  backgroundOverlay?: boolean;
  backgroundOverlayOpacity?: number;
  borderTop?: boolean;
  borderBottom?: boolean;
  borderColor?: string;
  borderWidth?: number;

  // Responsive
  hideOnMobile?: boolean;
  hideOnTablet?: boolean;
  hideOnDesktop?: boolean;

  // Animation
  animation?: 'none' | 'fade' | 'slideUp' | 'slideDown' | 'slideLeft' | 'slideRight' | 'zoom';
  animationDuration?: number;
  animationDelay?: number;

  // Advanced
  customClass?: string;
  id?: string;
}

interface SectionWrapperProps {
  settings?: SectionSettings;
  children: React.ReactNode;
  mode?: 'live' | 'preview';
}

const spacingMap = {
  none: '0',
  xs: '0.5rem',    // 8px
  sm: '1rem',      // 16px
  md: '1.5rem',    // 24px
  lg: '2.5rem',    // 40px
  xl: '4rem',      // 64px
  '2xl': '6rem',   // 96px
};

const maxWidthMap = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
  full: '100%',
};

export function SectionWrapper({
  settings = {},
  children,
  mode = 'live'
}: SectionWrapperProps) {
  const [isVisible, setIsVisible] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement>(null);

  const {
    fullWidth = false,
    maxWidth = 'xl',
    paddingTop = 'none',
    paddingBottom = 'none',
    paddingLeft = 'none',
    paddingRight = 'none',
    marginTop = 'none',
    marginBottom = 'none',
    backgroundColor,
    textColor,
    backgroundImage,
    backgroundSize = 'cover',
    backgroundPosition = 'center',
    backgroundOverlay = false,
    backgroundOverlayOpacity = 50,
    borderTop = false,
    borderBottom = false,
    borderColor = '#e5e7eb',
    borderWidth = 1,
    hideOnMobile = false,
    hideOnTablet = false,
    hideOnDesktop = false,
    animation = 'none',
    animationDuration = 600,
    animationDelay = 0,
    customClass = '',
    id,
  } = settings;

  // Intersection Observer for scroll animations
  React.useEffect(() => {
    if (animation === 'none' || mode === 'preview') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setTimeout(() => setIsVisible(true), animationDelay);
        }
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, [animation, animationDelay, mode]);

  // Responsive visibility classes
  const responsiveClasses = [
    hideOnMobile && 'hidden sm:block',
    hideOnTablet && 'sm:hidden lg:block',
    hideOnDesktop && 'lg:hidden',
  ].filter(Boolean).join(' ');

  // Animation classes
  const animationClasses = animation !== 'none' && !isVisible ? {
    fade: 'opacity-0',
    slideUp: 'opacity-0 translate-y-10',
    slideDown: 'opacity-0 -translate-y-10',
    slideLeft: 'opacity-0 translate-x-10',
    slideRight: 'opacity-0 -translate-x-10',
    zoom: 'opacity-0 scale-95',
  }[animation] : '';

  const animationTransition = animation !== 'none' ?
    `transition-all duration-[${animationDuration}ms] ease-out` : '';

  const visibleClasses = isVisible && animation !== 'none' ? 'opacity-100 translate-y-0 translate-x-0 scale-100' : '';

  // Styles object
  const styles: React.CSSProperties = {
    paddingTop: spacingMap[paddingTop],
    paddingBottom: spacingMap[paddingBottom],
    paddingLeft: fullWidth ? '0' : spacingMap[paddingLeft],
    paddingRight: fullWidth ? '0' : spacingMap[paddingRight],
    marginTop: spacingMap[marginTop],
    marginBottom: spacingMap[marginBottom],
    backgroundColor,
    color: textColor,
    backgroundImage: backgroundImage ? `url(${backgroundImage})` : undefined,
    backgroundSize,
    backgroundPosition,
    borderTopWidth: borderTop ? borderWidth : 0,
    borderBottomWidth: borderBottom ? borderWidth : 0,
    borderColor,
    position: backgroundOverlay && backgroundImage ? 'relative' : undefined,
  };

  return (
    <section
      ref={sectionRef}
      id={id}
      className={`${responsiveClasses} ${animationClasses} ${animationTransition} ${visibleClasses} ${customClass}`}
      style={styles}
    >
      {/* Background overlay */}
      {backgroundOverlay && backgroundImage && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{ opacity: backgroundOverlayOpacity / 100 }}
        />
      )}

      {/* Content container */}
      <div
        className={fullWidth ? 'w-full' : 'mx-auto'}
        style={{ maxWidth: fullWidth ? '100%' : maxWidthMap[maxWidth], position: 'relative' }}
      >
        {children}
      </div>
    </section>
  );
}
