import * as React from 'react';
import * as S from "@ds-stories/apps/tools/storybook/src/stories/form/date-picker.stories";

function compose(S: any, key: string) {
  const meta: any = S.default ?? {};
  const st: any = S[key];
  const args: any = { ...(meta.args ?? {}), ...(st && st.args ? st.args : {}) };
  const at: any = { ...(meta.argTypes ?? {}), ...(st && st.argTypes ? st.argTypes : {}) };
  for (const k of Object.keys(args)) {
    const m = at[k] && at[k].mapping;
    if (m && typeof m === 'object' && args[k] in m) args[k] = m[args[k]];
  }
  const title: string = typeof meta.title === 'string' ? meta.title : '';
  const ctx: any = {
    args, name: key, title, kind: title, id: '', componentId: '',
    globals: {}, viewMode: 'story',
    parameters: (st && st.parameters) ?? meta.parameters ?? {},
  };
  let render: (() => any) | null = null;
  if (st && typeof st.render === 'function') render = () => st.render(args, ctx);
  else if (typeof st === 'function') render = () => st(args, ctx);
  else if (typeof meta.render === 'function') render = () => meta.render(args, ctx);
  else {
    const C = (st && st.component) || meta.component;
    if (C) render = () => React.createElement(C, args);
  }
  if (!render) return () => null;
  const decorators: any[] = ([] as any[]).concat((st && st.decorators) ?? []).concat(meta.decorators ?? []);
  const composed = decorators.reduce((inner: any, dec: any) => () => {
    const out = dec(inner, ctx);
    return out === undefined ? inner() : out;
  }, render);
  // The story uses `layout: "centered"`, which wraps the story in a
  // shrink-to-content flex container; the DatePicker trigger button is
  // `w-full`, so under centered layout it sizes to its content rather than
  // stretching. The preview page is a full-width block, so without this
  // wrapper the `w-full` button spans the whole 900px page and no longer
  // matches the storybook render. An inline-flex wrapper reproduces the
  // shrink-to-content sizing of the centered layout.
  return () =>
    React.createElement('div', { style: { display: 'inline-flex' } }, composed());
}

export const Default = /* Default */ compose(S, "Default");
export const WithPreselectedDate = /* With Preselected Date */ compose(S, "WithPreselectedDate");
