// Magpie search plugin for Microsoft Web IQ (https://webiq.microsoft.ai/)
// Docs:
//   - https://learn.microsoft.com/en-us/web-iq/get-started/authentication
//   - https://learn.microsoft.com/en-us/web-iq/reference/web-search
//   - https://learn.microsoft.com/en-us/web-iq/concepts/content-formats
//   - https://learn.microsoft.com/en-us/web-iq/reference/error-handling

const DEFAULT_BASE_URL = "https://api.microsoft.ai/v3";
const VALID_FORMATS = new Set(["passage", "text", "markdown", "html"]);
const VALID_SAFE_SEARCH = new Set(["strict", "off"]);

function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRetryAfter(headerVal, bodyVal) {
  const raw = String(headerVal || bodyVal || "").trim();
  if (!raw) return "";
  // Web IQ throttled responses return durations like "60s"; HTTP Retry-After uses integer seconds or HTTP-date.
  const secMatch = /^(\d+(?:\.\d+)?)s$/i.exec(raw);
  if (secMatch) {
    return String(Math.max(1, Math.ceil(Number(secMatch[1]))));
  }
  return raw;
}

function isBearerToken(secret) {
  if (!secret) return false;
  if (/^bearer\s+/i.test(secret)) return true;
  // JWT format (Entra ID OAuth 2.0 access token): header.payload.signature
  const parts = secret.split(".");
  return parts.length === 3 && secret.startsWith("eyJ");
}

function buildEndpointAndOptions(rawUrl, usesApiKey) {
  const baseInput = String(rawUrl || "").trim() || DEFAULT_BASE_URL;
  const parsed = new URL(baseInput);

  // Optional local tuning via URL hash, e.g.:
  //   https://api.microsoft.ai/v3#contentFormat=passage&maxLength=3000&safeSearch=strict&language=en&region=US
  // Using hash keeps custom plugin options out of the upstream query string.
  const hashParams = new URLSearchParams(parsed.hash ? parsed.hash.slice(1) : "");
  parsed.hash = "";

  // Web IQ rejects API-key requests that carry an APPID query parameter (even empty) with 401 AuthUnauthorizedEntryId.
  if (usesApiKey && parsed.searchParams.has("APPID")) {
    parsed.searchParams.delete("APPID");
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") {
    pathname = "/v3/search/web";
  } else if (!pathname.endsWith("/search/web")) {
    pathname = `${pathname}/search/web`;
  }
  parsed.pathname = pathname;

  const formatRaw = (hashParams.get("contentFormat") || "passage").toLowerCase();
  const contentFormat = VALID_FORMATS.has(formatRaw) ? formatRaw : "passage";

  const defaultMaxLen = contentFormat === "passage" ? 3000 : 10000;
  const maxLenNum = Number(hashParams.get("maxLength"));
  const maxLength = Number.isFinite(maxLenNum) && maxLenNum >= 1
    ? Math.min(Math.floor(maxLenNum), 500000)
    : defaultMaxLen;

  const safeRaw = (hashParams.get("safeSearch") || "strict").toLowerCase();
  const safeSearch = VALID_SAFE_SEARCH.has(safeRaw) ? safeRaw : "strict";

  const language = (hashParams.get("language") || "").trim();
  const region = (hashParams.get("region") || "").trim();
  const scopeName = (hashParams.get("scopeName") || "").trim();

  return {
    endpoint: parsed.toString(),
    contentFormat,
    maxLength,
    safeSearch,
    language,
    region,
    scopeName,
  };
}

export default async function microsoftWebIqPlugin() {
  return {
    search: {
      web: {
        name: "Microsoft Web IQ",
        keysURL: "https://webiq.microsoft.ai/profiles/",
        async execute({ query, count, key, url }, ctx) {
          const trimmedQuery = String(query || "").trim().slice(0, 1000);
          if (!trimmedQuery) {
            return [];
          }

          const secret = String(key || "").trim();
          if (!secret) {
            throw Object.assign(
              new Error("Microsoft Web IQ API key is missing; add it via `magpie search add webiq-js:web <x-apikey>`"),
              { status: 401 }
            );
          }

          const bearer = isBearerToken(secret);
          const {
            endpoint,
            contentFormat,
            maxLength,
            safeSearch,
            language,
            region,
            scopeName,
          } = buildEndpointAndOptions(url, !bearer);

          const maxResults = Math.min(Math.max(Number(count) || 6, 1), 50);

          const body = {
            query: trimmedQuery,
            maxResults,
            contentFormat,
            maxLength,
            safeSearch,
          };
          if (language) body.language = language;
          if (region) body.region = region;
          if (scopeName) body.scopeName = scopeName;

          const headers = {
            "content-type": "application/json",
            "accept": "application/json",
          };
          if (bearer) {
            headers["authorization"] = /^bearer\s+/i.test(secret) ? secret : `Bearer ${secret}`;
          } else {
            headers["x-apikey"] = secret;
          }

          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: ctx?.abort,
          });

          const rawText = await res.text();
          let data = null;
          if (rawText) {
            try {
              data = JSON.parse(rawText);
            } catch {}
          }

          if (!res.ok) {
            const code = data?.errorCode ? `[${data.errorCode}] ` : "";
            const msg = data?.userMessage || data?.message || rawText || `HTTP ${res.status}`;
            const details = data?.technicalDetails ? ` (${data.technicalDetails})` : "";
            const trace = data?.traceId ? ` [traceId: ${data.traceId}]` : "";
            const retryAfter = normalizeRetryAfter(res.headers.get("retry-after"), data?.retryAfter);
            throw Object.assign(
              new Error(`Web IQ HTTP ${res.status}: ${code}${msg}${details}${trace}`),
              { status: res.status, retryAfter }
            );
          }

          const webResults = Array.isArray(data?.webResults) ? data.webResults : [];
          return webResults
            .filter((item) => item && typeof item === "object" && item.url)
            .map((item) => {
              const rawContent = typeof item.content === "string" ? item.content : "";
              const text = contentFormat === "html" ? stripHtml(rawContent) : rawContent;
              return {
                title: item.title || item.url,
                url: item.url,
                text,
                age: item.lastUpdatedAt || item.crawledAt || "",
              };
            });
        },
      },
    },
  };
}
