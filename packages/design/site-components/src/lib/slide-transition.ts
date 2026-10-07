export type SlideTransitionStyle = 'fade' | 'slide' | 'zoom';

/** Tailwind classes for one slide of a slideshow, given the active slide and transition style. */
export function slideTransitionClasses(
  transitionStyle: SlideTransitionStyle,
  index: number,
  currentSlide: number,
): string {
  const isActive = index === currentSlide;
  let stateClasses: string;
  if (transitionStyle === 'slide') {
    stateClasses = 'translate-x-full opacity-0 z-0';
    if (isActive) {
      stateClasses = 'translate-x-0 opacity-100 z-10';
    } else if (index < currentSlide) {
      stateClasses = '-translate-x-full opacity-0 z-0';
    }
  } else if (transitionStyle === 'zoom') {
    stateClasses = isActive ? 'scale-100 opacity-100 z-10' : 'scale-95 opacity-0 z-0';
  } else {
    stateClasses = isActive ? 'opacity-100 z-10' : 'opacity-0 z-0';
  }
  return `transition-all duration-600 ease-out ${stateClasses}`;
}
