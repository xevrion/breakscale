/**
 * Typings for deep imports of Lucide's per-icon modules.
 *
 * Each module under lucide-react/dist/esm/icons/ exports two things: the
 * React component (default) and `__iconNode`, the raw list of SVG primitives
 * the component is built from. The canvas draws nodes inside one big <svg>,
 * where a React component that renders its own <svg> root is the wrong tool;
 * the primitive list is exactly the right one, and importing it directly
 * also lets the bundler skip the component wrapper for icons only the
 * canvas uses. The package ships no typings for these deep paths, so this
 * wildcard declaration provides them.
 */
declare module 'lucide-react/dist/esm/icons/*' {
  /**
   * The icon's SVG primitives as [tagName, attributes] pairs, drawn in a
   * 24x24 viewBox with stroke-width 2 expected from the container.
   */
  export const __iconNode: [elementName: string, attrs: Record<string, string>][];
}
