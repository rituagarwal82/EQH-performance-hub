import { createFileRoute } from "@tanstack/react-router";

/**
 * THUMBNAILS, SERVED FROM OUR OWN ADDRESS.
 *
 * The daily email must never load pictures straight from Meta's image servers:
 * those addresses are long, expiring and remote-tracking shaped, which is
 * exactly what pushes a one-person report into the spam folder. The email asks
 * for the picture here instead, and this door fetches it once and passes it on.
 *
 * Only Meta's own image hosts are allowed through, so this can never be used
 * to fetch anything else.
 */
const ALLOWED = [".fbcdn.net", ".cdninstagram.com", ".facebook.com"];

export const Route = createFileRoute("/api/public/img")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const adId = params.get("ad");
        let src = params.get("u");

        // Meta's stored picture addresses are signed and stop working after a
        // few days, so where we know the ad we ask Meta for a fresh one first.
        if (adId && /^\d+$/.test(adId)) {
          const token = process.env["META_ACCESS_TOKEN"];
          if (token) {
            try {
              const w = Number(params.get("w") ?? 96) * 2;
              const res = await fetch(
                `https://graph.facebook.com/v21.0/${adId}?fields=creative{thumbnail_url}&thumbnail_width=${w}&thumbnail_height=${w}&access_token=${encodeURIComponent(token)}`,
              );
              if (res.ok) {
                const body = (await res.json()) as {
                  creative?: { thumbnail_url?: string };
                };
                if (body.creative?.thumbnail_url) src = body.creative.thumbnail_url;
              }
            } catch {
              // Fall back to the stored address below.
            }
          }
        }

        if (!src) return new Response("missing image", { status: 400 });

        let target: URL;
        try {
          target = new URL(src);
        } catch {
          return new Response("bad image address", { status: 400 });
        }
        const host = target.hostname.toLowerCase();
        const ok =
          target.protocol === "https:" && ALLOWED.some((d) => host === d.slice(1) || host.endsWith(d));
        if (!ok) return new Response("image address not allowed", { status: 403 });

        try {
          const res = await fetch(target.toString());
          if (!res.ok) return new Response("image not available", { status: 404 });
          const type = res.headers.get("content-type") ?? "image/jpeg";
          if (!type.startsWith("image/")) return new Response("not an image", { status: 415 });
          const body = await res.arrayBuffer();
          return new Response(body, {
            headers: {
              "Content-Type": type,
              // The picture behind an ad does not change, so it can be held for
              // a week — an inbox that reopens the email asks us once.
              "Cache-Control": "public, max-age=604800",
              "Content-Length": String(body.byteLength),
            },
          });
        } catch {
          return new Response("image not available", { status: 502 });
        }
      },
    },
  },
});
