/** The viewer may not list this object at all (no read permission, or a form that is not theirs to see). */
export class SheetDataPermissionError extends Error {
  constructor(readonly permission: string) {
    super(`Listing these records needs '${permission}'`);
    this.name = 'SheetDataPermissionError';
  }
}
