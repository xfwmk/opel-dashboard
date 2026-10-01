export function onRequestGet(context) {
  return Response.json({
    ok: true,
    function: "analytics-dashboard",
    hasCloudflareApiToken: Boolean(context.env.CLOUDFLARE_API_TOKEN),
    hasCloudflareZoneId: Boolean(context.env.CLOUDFLARE_ZONE_ID),
    time: new Date().toISOString()
  }, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
