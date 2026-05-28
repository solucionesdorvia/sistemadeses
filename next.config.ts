import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist usa workers + .mjs internos que Next.js no bundlea bien.
  // Marcarlo como external le pide al server cargarlo desde node_modules
  // directamente — necesario para que /api/boletas/process funcione en
  // produccion.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
