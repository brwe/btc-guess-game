const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

function corsHeaders(origin: string | null) {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

Bun.serve({
  port,
  hostname: host,
  fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const headers = new Headers(corsHeaders(origin));

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/api/hello") {
      console.log(`[api] ${req.method} ${url.pathname}`);
      return Response.json(
        {
          message: "hello world from the backend",
        },
        { headers },
      );
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers });
    }

    return new Response("Not found", { status: 404, headers });
  },
});

console.log(`Backend listening on http://${host}:${port}`);
