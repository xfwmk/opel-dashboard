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

function getPeriod(range) {
  const now = Date.now();

  let milliseconds;

  switch (range) {
    case "24h":
      milliseconds = 24 * 60 * 60 * 1000;
      break;

    case "30d":
      milliseconds = 30 * 24 * 60 * 60 * 1000;
      break;

    case "7d":
    default:
      milliseconds = 7 * 24 * 60 * 60 * 1000;
      break;
  }

  return {
    since: new Date(now - milliseconds).toISOString(),
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

    /*
     * CORS
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    /*
     * Health check
     */
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        worker: true,
        time: new Date().toISOString(),
      });
    }

    /*
     * Analytics endpoint
     */
    if (url.pathname === "/api/analytics") {
      if (request.method !== "GET") {
        return json(
          {
            error: "Method not allowed",
          },
          405
        );
      }

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

      /*
       * The dashboard sends ?range=24h / 7d / 30d
       */
      const range =
        url.searchParams.get("range") || "7d";

      const { since, until } =
        getPeriod(range);

      /*
       * We use separate GraphQL groups for each
       * dashboard section.
       *
       * This prevents metrics from being accidentally
       * multiplied by grouping on several dimensions
       * at the same time.
       */
      const query = `
        query DashboardAnalytics(
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

              summary:
                httpRequestsAdaptiveGroups(
                  limit: 1
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
                }

              traffic:
                httpRequestsAdaptiveGroups(
                  limit: 10000
                  filter: {
                    datetime_geq: $start
                    datetime_lt: $end
                    requestSource: "eyeball"
                  }
                  orderBy: [datetimeHour_ASC]
                ) {
                  count

                  dimensions {
                    datetimeHour
                  }
                }

              countries:
                httpRequestsAdaptiveGroups(
                  limit: 100
                  filter: {
                    datetime_geq: $start
                    datetime_lt: $end
                    requestSource: "eyeball"
                  }
                  orderBy: [count_DESC]
                ) {
                  count

                  dimensions {
                    clientCountryName
                  }
                }

              paths:
                httpRequestsAdaptiveGroups(
                  limit: 100
                  filter: {
                    datetime_geq: $start
                    datetime_lt: $end
                    requestSource: "eyeball"
                  }
                  orderBy: [count_DESC]
                ) {
                  count

                  dimensions {
                    clientRequestPath
                  }
                }

              devices:
                httpRequestsAdaptiveGroups(
                  limit: 100
                  filter: {
                    datetime_geq: $start
                    datetime_lt: $end
                    requestSource: "eyeball"
                  }
                  orderBy: [count_DESC]
                ) {
                  count

                  dimensions {
                    device: clientDeviceType
                  }
                }

              statuses:
                httpRequestsAdaptiveGroups(
                  limit: 100
                  filter: {
                    datetime_geq: $start
                    datetime_lt: $end
                    requestSource: "eyeball"
                  }
                  orderBy: [count_DESC]
                ) {
                  count

                  dimensions {
                    status: edgeResponseStatus
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

        /*
         * HTTP/API failure
         */
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

        /*
         * GraphQL failure
         */
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

        const zone =
          body?.data?.viewer?.zones?.[0];

        if (!zone) {
          return json(
            {
              error:
                "Cloudflare returned no zone data",
            },
            502
          );
        }

        /*
         * SUMMARY
         */
        const summaryRows =
          zone.summary || [];

        let requests = 0;
        let visits = 0;
        let bandwidth = 0;

        for (const row of summaryRows) {
          requests +=
            Number(row.count || 0);

          visits +=
            Number(row.sum?.visits || 0);

          bandwidth +=
            Number(
              row.sum?.edgeResponseBytes ||
                0
            );
        }

        /*
         * TRAFFIC
         */
        const trafficMap = {};

        for (const row of zone.traffic || []) {
          const time =
            row.dimensions?.datetimeHour;

          if (!time) continue;

          trafficMap[time] =
            (trafficMap[time] || 0) +
            Number(row.count || 0);
        }

        const traffic =
          Object.entries(trafficMap)
            .sort(
              (a, b) =>
                new Date(a[0]) -
                new Date(b[0])
            )
            .map(([time, value]) => ({
              label: new Date(time)
                .toLocaleString(
                  "en-GB",
                  {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                  }
                ),

              value,
            }));

        /*
         * COUNTRIES
         */
        const countriesMap = {};

        for (const row of zone.countries || []) {
          const country =
            row.dimensions
              ?.clientCountryName;

          if (!country) continue;

          countriesMap[country] =
            (countriesMap[country] || 0) +
            Number(row.count || 0);
        }

        const countries =
          topItems(countriesMap, 10);

        /*
         * PATHS
         */
        const pathsMap = {};

        for (const row of zone.paths || []) {
          const path =
            row.dimensions
              ?.clientRequestPath;

          if (!path) continue;

          pathsMap[path] =
            (pathsMap[path] || 0) +
            Number(row.count || 0);
        }

        const paths =
          topItems(pathsMap, 10);

        /*
         * DEVICES
         */
        const devicesMap = {};

        for (const row of zone.devices || []) {
          const device =
            row.dimensions?.device;

          if (!device) continue;

          devicesMap[device] =
            (devicesMap[device] || 0) +
            Number(row.count || 0);
        }

        const devices =
          topItems(devicesMap, 10);

        /*
         * HTTP STATUS
         */
        const statusesMap = {};

        for (const row of zone.statuses || []) {
          const status =
            row.dimensions?.status;

          if (
            status === null ||
            status === undefined
          ) {
            continue;
          }

          const key = String(status);

          statusesMap[key] =
            (statusesMap[key] || 0) +
            Number(row.count || 0);
        }

        const statuses =
          topItems(statusesMap, 20);

        /*
         * SUCCESS RATE
         *
         * Dashboard describes this as:
         * 2xx + 3xx responses.
         */
        let successful = 0;

        for (const item of statuses) {
          const status =
            Number(item.name);

          if (
            status >= 200 &&
            status < 400
          ) {
            successful +=
              Number(item.value || 0);
          }
        }

        const successRate =
          requests > 0
            ? (successful / requests) * 100
            : 0;

        /*
         * FINAL RESPONSE
         *
         * This shape exactly matches the
         * dashboard's JavaScript.
         */
        return json({
          ok: true,

          range,

          period: {
            since,
            until,
          },

          summary: {
            requests,
            visits,
            bandwidth,
            successRate,
          },

          traffic,

          countries,

          paths,

          devices,

          statuses,
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
     * Everything else is served from /public
     */
    return env.ASSETS.fetch(request);
  },
};