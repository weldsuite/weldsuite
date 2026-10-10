/** The signed-in member's employee record, loaded once by the My HR layout for every My HR page. */

import { createContext, useContext, type ReactNode } from 'react';
import type { HrSelf, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';

export interface MyHrSelf {
  employee: HrSelfProfile;
  features: HrSelf['features'];
}

const MyHrContext = createContext<MyHrSelf | null>(null);

export function MyHrProvider({ value, children }: Readonly<{ value: MyHrSelf; children: ReactNode }>) {
  return <MyHrContext.Provider value={value}>{children}</MyHrContext.Provider>;
}

/** Only inside the My HR layout, which renders its pages once the employee record is there. */
export function useMyHrSelf(): MyHrSelf {
  const value = useContext(MyHrContext);
  if (!value) throw new Error('useMyHrSelf must be used inside the My HR layout');
  return value;
}
