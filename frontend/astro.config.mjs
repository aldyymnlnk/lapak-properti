// @ts-check
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://infoproperti.web.id",
  output: "server",
  adapter: cloudflare(),
  vite: {
    plugins: [/** @type {any} */ (tailwindcss())],
  },
});