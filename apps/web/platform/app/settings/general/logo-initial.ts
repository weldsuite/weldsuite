// Letter shown in the logo placeholder; 'L' only when there is no name at all.
export function getLogoInitial(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : 'L';
}
