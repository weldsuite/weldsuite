// Lives in @weldsuite/db, so code that outlives the workers (collab-rooms) has it without worker-kit.
export { atomically } from '@weldsuite/db/lib/atomically';
