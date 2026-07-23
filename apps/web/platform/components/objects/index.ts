/**
 * Auto-registers every object panel by importing each `index.ts`. Importing
 * this file once at app boot (see `src/routes/__root.tsx`) guarantees the
 * panel registry is populated before `<ObjectPanelHost />` mounts.
 *
 * When adding a new object: create `components/objects/{type}/index.ts` that
 * calls `registerObjectPanel(...)` as a side effect, then add the import
 * below.
 */

import './company';
import './channel';
import './person';
import './team-member';
import './task';
import './opportunity';
import './lead';
import './welddata-lead';
import './ticket';
import './article';
import './project';
import './invoice';
import './bill';
import './domain';
