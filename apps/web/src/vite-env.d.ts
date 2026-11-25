interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

declare module "*.md?raw" {
  const text: string;
  export default text;
}
