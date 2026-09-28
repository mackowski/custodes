// Vite inlines `?raw` imports as strings at test build time.
declare module '*?raw' {
  const content: string;
  export default content;
}
