/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_REGULA_LICENSE: string;
    // Agrega aquí otras variables si tienes
  }
  
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  