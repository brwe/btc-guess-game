import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://backend:3001",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (_error, _request, browserResponse) => {
            if ("req" in browserResponse && !browserResponse.destroyed) {
              browserResponse.destroy();
            }
          });

          proxy.on("proxyRes", (proxyResponse, _request, browserResponse) => {
            const closeBrowserConnection = () => {
              if (!browserResponse.destroyed) browserResponse.destroy();
            };

            proxyResponse.on("aborted", closeBrowserConnection);
            proxyResponse.on("error", closeBrowserConnection);
            proxyResponse.on("close", () => {
              if (!proxyResponse.complete) closeBrowserConnection();
            });
          });
        },
      },
    },
  },
});
