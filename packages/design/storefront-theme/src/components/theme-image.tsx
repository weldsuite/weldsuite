import { safeImageSrc } from '../links';

export interface ThemeImageProps {
  src: unknown;
  /** The image description; '' marks it decorative. */
  alt: string;
  /**
   * The page's largest image, likely its LCP: loaded at once with
   * `fetchpriority="high"`. Every other image is lazy and decoded off the
   * main thread.
   */
  priority?: boolean;
  className?: string;
  sizes?: string;
  width?: number;
  height?: number;
}

/** An image from a section setting or the catalogue; nothing when the source is not safe. */
export function ThemeImage({ src, alt, priority = false, className, sizes, width, height }: Readonly<ThemeImageProps>) {
  const safe = safeImageSrc(src);
  if (!safe) return null;
  if (priority) {
    return <img src={safe} alt={alt} fetchPriority="high" className={className} sizes={sizes} width={width} height={height} />;
  }
  return (
    <img src={safe} alt={alt} loading="lazy" decoding="async" className={className} sizes={sizes} width={width} height={height} />
  );
}
