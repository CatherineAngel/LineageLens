/** The lineage engine is inlined as text at build time (esbuild .py loader). */
declare module "*.py" {
  const source: string;
  export default source;
}
