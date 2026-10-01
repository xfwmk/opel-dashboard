const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const HOSTNAME = "opel.org.uk";

const QUERY = `
query Dashboard($zoneTag: string, $filter: filter) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      summary: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 1
      ) {
        count
        sum {
          visits
          edgeResponseBytes
        }
      }
      traffic: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 1000
        orderBy: [datetimeHour_ASC]
      ) {
        count
        dimensions {
          datetimeHour
        }
      }
      countries: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        sum {
          visits
        }
        dimensions {
          clientCountryName
        }
      }
      paths: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          clientRequestPath
        }
      }
      devices: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        sum {
          visits
        }
        dimensions {
          clientDeviceType
        }
      }
      statuses: httpRequestsAdaptiveGroups(
        filter: $filter
        limit: 100
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          edgeResponseStatus
        }
      }
    }
  }
}`;

function dateRange(range) {
  const end = new Date();
  const start = new Date(end);

  if (range === "24h") {
    start.setHours(start.getHours() - 24);
  } else if (range === "30d") {
    start.setDate(start.getDate() - 30);
  } else {
    start.setDate(start.getDate() - 7);
  }

  return { start: start.toISOString(), end: end.toISOString() };
}

function filterFor(start, end) {
  return {
    datetime_geq: start,
    datetime_lt: end,
    clientRequestHTTPHost: HOSTNAME,
    requestSource: "eyeball"
  };
}

async function cloudflareGraphql(env, variables) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN secret in the Production environment.");
  }

  if (!env.CLOUDFLARE_ZONE_ID) {
    throw new Error("Missing CLOUDFLARE_ZONE_ID variable in the Production environment.");
  }

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query: QUERY,
      variables
    })
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare returned HTTP ${response.status} without JSON.`);
  }

  if (!response.ok || body?.errors?.length) {
    const message = body?.errors?.map((e) => e?.message).filter(Boolean).join("; ");
    const error = message || `Cloudflare returned HTTP ${response.status}.`;
    throw new Error(error);
  }

  const zone = body?.data?.viewer?.zones?.[0];
  if (!zone) {
    throw new Error("Cloudflare returned no data for the configured zone.");
  }

  return zone;
}

function cleanRows(rows, nameKey, useVisits = false) {
  return (rows || [])
    .map((row) => ({
      name: row?.dimensions?.[nameKey] ?? "Unknown",
      value: Number(useVisits ? row?.sum?.visits : row?.count) || 0
    }))
    .filter((row) => row.name !== "Unknown" || row.value > 0);
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const range = ["24h", "7d", "30d"].includes(url.searchParams.get("range"))
    ? url.searchParams.get("range")
    : "7d";

  try {
    const { start, end } = dateRange(range);

    const zone = await cloudflareGraphql(context.env, {
      zoneTag: context.env.CLOUDFLARE_ZONE_ID,
      filter: filterFor(start, end)
    });

    const summary = zone.summary?.[0] || {};

    const traffic = (zone.traffic || []).map((row) => ({
      label: new Date(row?.dimensions?.datetimeHour).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit"
      }),
      value: Number(row?.count) || 0
    }));

    const statuses = cleanRows(zone.statuses, "edgeResponseStatus");
    const statusTotal = statuses.reduce((sum, row) => sum + row.value, 0);
    const successful = statuses
      .filter((row) => {
        const code = Number(row.name);
        return code >= 200 && code < 400;
      })
      .reduce((sum, row) => sum + row.value, 0);

    return json({
      range,
      from: start,
      to: end,
      host: HOSTNAME,
      summary: {
        requests: Number(summary.count) || 0,
        visits: Number(summary.sum?.visits) || 0,
        bandwidth: Number(summary.sum?.edgeResponseBytes) || 0,
        successRate: statusTotal
          ? (successful / statusTotal) * 100
          : 0
      },
      traffic,
      countries: cleanRows(zone.countries, "clientCountryName", true),
      paths: cleanRows(zone.paths, "clientRequestPath"),
      devices: cleanRows(zone.devices, "clientDeviceType", true),
      statuses
    });
  } catch (error) {
    return json(
      {
        error: error?.message || "Analytics query failed",
        hint: "For GraphQL Analytics, the token needs Account → Account Analytics → Read, scoped to the opel.org.uk zone."
      },
      502
    );
  }
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  return onRequestGet(context);
}
