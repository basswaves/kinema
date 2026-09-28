/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Kinema's own TMDB key, set at build time — see src/metadata/builtinKey.ts. */
  readonly VITE_TMDB_API_KEY?: string;
}
