// Vite inlines `?raw` imports as strings at test build time.
declare module '*?raw' {
  const content: string;
  export default content;
}

// Vite's `import.meta.glob`, used eagerly with `?raw` to read source files in tests.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, T>;
}
