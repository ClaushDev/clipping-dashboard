import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CLIPPING_API: otro backend (p. ej. la copia de verificación en 8766) sin tocar la app que tienes abierta.
const backend = process.env.CLIPPING_API || "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": backend, "/media": backend },
  },
});
