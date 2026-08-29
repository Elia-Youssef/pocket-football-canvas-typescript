/**
 * Stylesheets are modules to the bundler and nothing to the type system, so the
 * type checker needs to be told they resolve. Declared here rather than by
 * widening the project's ambient type set to the bundler's whole client
 * surface, which would also declare an environment object that item A2 forbids
 * from ever reaching the emitted bytes.
 *
 * The default export is the emitted asset reference. Nothing in this project
 * uses it: the one import of a stylesheet, in src/main.ts, is for the side
 * effect of the asset being emitted and linked.
 *
 * DELIBERATELY NARROW, AND IT WILL NEED WIDENING ONCE. This one shape is
 * declared for every specifier ending in .css, which is right for a side-effect
 * import and wrong for three others the bundler supports: a ?inline import
 * yields the stylesheet text, a ?url import yields a URL, and a CSS-modules
 * import yields a record of class names, none of which is this string. Nothing
 * here uses any of them today. The part that first needs one narrows this
 * declaration to match, rather than leaving a type that quietly lies about what
 * came back.
 */
declare module '*.css' {
  const stylesheet: string;
  export default stylesheet;
}
