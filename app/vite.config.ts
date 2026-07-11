import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Node globals some Solana deps expect in the browser.
export default defineConfig({
  define: {
    "process.env": {},
    global: "globalThis",
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Tap-Duel Arena",
        short_name: "Tap-Duel",
        description:
          "Real-time 1v1 tug-of-war on Solana. Gasless taps on MagicBlock Ephemeral Rollups.",
        theme_color: "#0a0a12",
        background_color: "#0a0a12",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
      },
    }),
  ],
});
