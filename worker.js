const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

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

  if (period === "7d") {
    return {
      since: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      until: new Date(now).toISOString(),
    };
  }

  if (period === "30d") {
    return {
      since: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      until: new Date(now).toISOString(),
    };
  }

  return {
    since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
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

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: true,
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/analytics") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      if (!env.CLOUDFLARE_API_TOKEN) {
        return json(
          {
            error: "CLOUDFLARE_API_TOKEN is not configured",
          },
          500
        );
      }

      if (!env.CLOUDFLARE_ZONE_ID) {
        return json(
          {
            error: "CLOUDFLARE_ZONE_ID is not configured",
          },
          500
        );
      }

      const period = url.searchParams.get("period") || "24h";
      const { since, until } = getPeriod(period);

      const query = `
        query Analytics(
          $zoneTag: string
          $start: Time
          $end: Time
        ) {
          viewer {
            zones(filter: { zoneTag: $zoneTag }) {
              httpRequests1hGroups(
                limit: 10000
                filter: {
                  datetime_geq: $start
                  datetime_lt: $end
                }
              ) {
                dimensions {
                  datetimeHour
                }

                sum {
                  requests
                  bytes
                  pageViews

                  countryMap {
                    requests
                    clientCountryName
                  }

                  responseStatusMap {
                    requests
                    edgeResponseStatus
                  }

                  browserMap {
                    requests
                    uaBrowserFamily
                  }
                }

                uniq {
                  uniques
                }
              }
            }
          }
        }
      `;

      try {
        const response = await fetch(GRAPHQL_ENDPOINT, {
          method: "POST",

          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            query,

            variables: {
              zoneTag: env.CLOUDFLARE_ZONE_ID,
              start: since,
              end: until,
            },
          }),
        });

        const body = await response.json();

        if (!response.ok) {
          return json(
            {
              error: "Cloudflare Analytics request failed",
              status: response.status,
              details: body,
            },
            502
          );
        }

        if (body.errors?.length) {
          return json(
            {
              error: "Cloudflare GraphQL returned an error",
              details: body.errors,
            },
            502
          );
        }

        const groups =
          body?.data?.viewer?.zones?.[0]?.httpRequests1hGroups || [];

        let visitors = 0;
        let pageViews = 0;
        let requests = 0;
        let bandwidth = 0;

        const countries = {};
        const statuses = {};
        const browsers = {};

        const traffic = [];

        for (const group of groups) {
          const sum = group.sum || {};
          const uniq = group.uniq || {};

          const groupRequests = Number(sum.requests || 0);
          const groupBytes = Number(sum.bytes || 0);
          const groupPageViews = Number(sum.pageViews || 0);
          const groupVisitors = Number(uniq.uniques || 0);

          requests += groupRequests;
          bandwidth += groupBytes;
          pageViews += groupPageViews;
          visitors += groupVisitors;

          traffic.push({
            time: group?.dimensions?.datetimeHour || null,
            requests: groupRequests,
            pageViews: groupPageViews,
            visitors: groupVisitors,
            bytes: groupBytes,
          });

          for (const country of sum.countryMap || []) {
            const name = country.clientCountryName;

            if (!name) continue;

            countries[name] =
              (countries[name] || 0) +
              Number(country.requests || 0);
          }

          for (const status of sum.responseStatusMap || []) {
            const code = String(status.edgeResponseStatus);

            statuses[code] =
              (statuses[code] || 0) +
              Number(status.requests || 0);
          }

          for (const browser of sum.browserMap || []) {
            const name = browser.uaBrowserFamily;

            if (!name) continue;

            browsers[name] =
              (browsers[name] || 0) +
              Number(browser.requests || 0);
          }
        }

        return json({
          ok: true,

          period: {
            name: period,
            since,
            until,
          },

          visitors,
          pageViews,
          requests,
          bandwidth,

          averageResponse: null,

          traffic,

          countries: topItems(countries, 10),

          browsers: topItems(browsers, 10),

          statuses: topItems(statuses, 10),

          topPages: [],

          popularLinks: [],
        });
      } catch (error) {
        return json(
          {
            error: "Failed to contact Cloudflare Analytics",
            details:
              error instanceof Error
                ? error.message
                : String(error),
          },
          502
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};