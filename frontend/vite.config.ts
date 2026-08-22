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
          proxy.on("error", (_error, request, browserResponse) => {
            const isEventStream = /\/events(?:\?|$)/.test(request.url ?? "");
            if (!isEventStream || !("req" in browserResponse) || browserResponse.destroyed) return;

            if (!browserResponse.headersSent) {
              browserResponse.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              browserResponse.flushHeaders();
            }
            browserResponse.destroy();
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
