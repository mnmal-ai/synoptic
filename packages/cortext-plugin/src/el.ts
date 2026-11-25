import type { RenderElement } from 'claude-code';

/** One element: `h` with its result narrowed to what a Box child and a render hook take. */
export function el(...args: Parameters<typeof h>): RenderElement {
  const [tag, props, ...children] = args;
  // An undefined prop is left out: a surface checks props against an allowlist of set values.
  const set = props
    ? Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined))
    : props;
  // biome-ignore lint/correctness/noUndeclaredVariables: `h` is the engine's global JSX factory in a hooks module
  return h(tag, set, ...children) as RenderElement;
}
