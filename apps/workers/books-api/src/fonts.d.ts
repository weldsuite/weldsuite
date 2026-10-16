/** Font files are bundled as Data modules (wrangler.toml [[rules]]): their bytes. */
declare module '*.ttf' {
  const bytes: ArrayBuffer;
  export default bytes;
}
