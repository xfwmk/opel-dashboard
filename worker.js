const GRAPHQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/graphql";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}

function getPeriod(period) {
  const now = Date.now();

  const hours =
    period === "30d"
      ? 30 * 24
      : period === "7d"
        ? 7 * 24
        : 24;

  return {
    since: new Date(
      now - hours * 60 * 60 * 1000
    ).toISOString(),

    until: new Date(now).toISOString(),
  };
}

function topItems(map, limit = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      value,
    }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    /*
     * Worker health check
     */
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: true,
        time: new Date().toISOString(),
      });
    }

    /*
     * Cloudflare Analytics
     */
    if (url.pathname === "/api/analytics") {
      if (!env.CLOUDFLARE_API_TOKEN) {
        return json(
          {
            error:
              "CLOUDFLARE_API_TOKEN is not configured",
          },
          500
        );
      }

      if (!env.CLOUDFLARE_ZONE_ID) {
        return json(
          {
            error:
              "CLOUDFLARE_ZONE_ID is not configured",
          },
          500
        );
      }

      const period =
        url.searchParams.get("period") || "24h";

      const { since, until } =
        getPeriod(period);

      const query = `
        query Analytics(
          $zoneTag: string
          $start: Time
          $end: Time
        ) {
          viewer {
            zones(
              filter: {
                zoneTag: $zoneTag
              }
            ) {
              httpRequestsAdaptiveGroups(
                limit: 10000

                filter: {
                  datetime_geq: $start
                  datetime_lt: $end
                  requestSource: "eyeball"
                }
              ) {
                count

                sum {
                  visits
                  edgeResponseBytes
                }

                dimensions {
                  datetimeHour
                  clientCountryName
                  edgeResponseStatus
                  clientRequestPath
                }
              }
            }
          }
        }
      `;

      try {
        const response = await fetch(
          GRAPHQL_ENDPOINT,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${env.CLOUDFLARE_API_TOKEN}`,

              "Content-Type":
                "application/json",

              Accept:
                "application/json",
            },

            body: JSON.stringify({
              query,

              variables: {
                zoneTag:
                  env.CLOUDFLARE_ZONE_ID,

                start: since,
                end: until,
              },
            }),
          }
        );

        const body =
          await response.json();

        if (!response.ok) {
          return json(
            {
              error:
                "Cloudflare Analytics request failed",

              status:
                response.status,

              details: body,
            },
            502
          );
        }

        if (body.errors?.length) {
          return json(
            {
              error:
                "Cloudflare GraphQL returned an error",

              details:
                body.errors,
            },
            502
          );
        }

        const groups =
          body?.data?.viewer?.zones?.[0]
            ?.httpRequestsAdaptiveGroups || [];

        let requests = 0;
        let visitors = 0;
        let bandwidth = 0;

        const countries = {};
        const statuses = {};
        const pages = {};
        const traffic = {};

        for (const group of groups) {
          const count =
            Number(group.count || 0);

          const visits =
            Number(
              group.sum?.visits || 0
            );

          const bytes =
            Number(
              group.sum?.edgeResponseBytes ||
                0
            );

          requests += count;
          visitors += visits;
          bandwidth += bytes;

          const dimensions =
            group.dimensions || {};

          /*
           * Traffic by hour
           */
          if (dimensions.datetimeHour) {
            const hour =
              dimensions.datetimeHour;

            if (!traffic[hour]) {
              traffic[hour] = {
                time: hour,
                requests: 0,
                visitors: 0,
                bytes: 0,
              };
            }

            traffic[hour].requests +=
              count;

            traffic[hour].visitors +=
              visits;

            traffic[hour].bytes +=
              bytes;
          }

          /*
           * Countries
           */
          if (
            dimensions.clientCountryName
          ) {
            const country =
              dimensions.clientCountryName;

            countries[country] =
              (countries[country] || 0) +
              count;
          }

          /*
           * HTTP status codes
           */
          if (
            dimensions.edgeResponseStatus
          ) {
            const status =
              String(
                dimensions.edgeResponseStatus
              );

            statuses[status] =
              (statuses[status] || 0) +
              count;
          }

          /*
           * Pages
           */
          if (
            dimensions.clientRequestPath
          ) {
            const path =
              dimensions.clientRequestPath;

            pages[path] =
              (pages[path] || 0) +
              count;
          }
        }

        return json({
  ok: true,

  period: {
    name: period,
    since,
    until,
  },

  summary: {
    visitors,
    requests,
    pageViews: visitors,
    bandwidth,
    averageResponse: null,
  },

  visitors,
  requests,
  pageViews: visitors,
  bandwidth,

  averageResponse: null,

  traffic:
    Object.values(traffic)
      .sort(
        (a, b) =>
          new Date(a.time) -
          new Date(b.time)
      ),

  countries:
    topItems(countries, 10),

  statuses:
    topItems(statuses, 10),

  topPages:
    topItems(pages, 10),

  popularLinks: [],
});
      } catch (error) {
        return json(
          {
            error:
              "Failed to contact Cloudflare Analytics",

            details:
              error instanceof Error
                ? error.message
                : String(error),
          },
          502
        );
      }
    }

    /*
     * Everything else:
     * serve public/
     */
    return env.ASSETS.fetch(request);
  },
};