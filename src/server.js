import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "connektly-meta-verify-token";
const APP_SECRET = process.env.META_APP_SECRET || "";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 1000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataFile = path.join(rootDir, "data", "events.json");
const publicDir = path.join(rootDir, "public");

const USE_CASES = {
  ads_management: "Create and Manage Ads",
  ad_apps: "Manage Ad Apps",
  whatsapp_cloud_api: "Connect on WhatsApp (Cloud API Platform)",
  ad_performance: "Measure Ad Performance",
  leads_management: "Capture and Manage Leads",
  pages_management: "Manage Pages",
  instagram_api: "Instagram API",
  messenger: "Messenger from Meta"
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadEvents() {
  if (!fs.existsSync(dataFile)) return [];
  const raw = fs.readFileSync(dataFile, "utf8");
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveEvents(events) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(events, null, 2), "utf8");
}

const eventStore = {
  events: loadEvents(),
  addMany(incomingEvents) {
    this.events = [...incomingEvents, ...this.events].slice(0, MAX_EVENTS);
    saveEvents(this.events);
  },
  all({ type, source, limit }) {
    return this.events
      .filter((event) => (type ? event.useCaseKey === type : true))
      .filter((event) => (source ? event.sourceObject === source : true))
      .slice(0, limit);
  },
  stats() {
    const byUseCase = Object.fromEntries(Object.keys(USE_CASES).map((key) => [key, 0]));
    const bySource = {};

    for (const event of this.events) {
      if (byUseCase[event.useCaseKey] !== undefined) byUseCase[event.useCaseKey] += 1;
      bySource[event.sourceObject] = (bySource[event.sourceObject] || 0) + 1;
    }

    return {
      total: this.events.length,
      byUseCase,
      bySource,
      labels: USE_CASES
    };
  }
};

function mapEventToUseCase(sourceObject, field, value) {
  const object = String(sourceObject || "").toLowerCase();
  const normalizedField = String(field || "").toLowerCase();

  if (object === "whatsapp_business_account" || value?.messaging_product === "whatsapp") return "whatsapp_cloud_api";
  if (object === "instagram" || normalizedField.includes("instagram")) return "instagram_api";
  if (normalizedField.includes("lead") || value?.leadgen_id || value?.form_id) return "leads_management";

  const hasMessagingArray = Array.isArray(value?.messaging) && value.messaging.length > 0;
  if (hasMessagingArray) return "messenger";

  if (object === "page" && normalizedField.includes("feed")) return "pages_management";
  if (object === "page" && normalizedField.includes("message")) return "messenger";

  if (normalizedField.includes("adcreative") || normalizedField.includes("adset") || normalizedField === "ads") return "ads_management";
  if (normalizedField.includes("application") || normalizedField.includes("app")) return "ad_apps";
  if (normalizedField.includes("insights") || normalizedField.includes("performance") || value?.metric) return "ad_performance";

  if (object === "page") return "pages_management";
  return "ad_performance";
}

function flattenPayloadToEvents(payload) {
  const sourceObject = payload?.object || "unknown";
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const now = new Date().toISOString();

  const events = [];

  if (!entries.length) {
    const useCaseKey = mapEventToUseCase(sourceObject, "", payload);
    events.push({
      id: crypto.randomUUID(),
      receivedAt: now,
      sourceObject,
      field: "",
      useCaseKey,
      useCaseLabel: USE_CASES[useCaseKey],
      payload
    });
    return events;
  }

  for (const entry of entries) {
    const entryId = entry?.id ?? null;
    const entryTime = entry?.time ?? null;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    if (!changes.length) {
      const useCaseKey = mapEventToUseCase(sourceObject, "", entry);
      events.push({
        id: crypto.randomUUID(),
        receivedAt: now,
        sourceObject,
        entryId,
        entryTime,
        field: "",
        useCaseKey,
        useCaseLabel: USE_CASES[useCaseKey],
        payload: entry
      });
      continue;
    }

    for (const change of changes) {
      const field = change?.field || "";
      const value = change?.value || {};
      const useCaseKey = mapEventToUseCase(sourceObject, field, value);
      events.push({
        id: crypto.randomUUID(),
        receivedAt: now,
        sourceObject,
        entryId,
        entryTime,
        field,
        useCaseKey,
        useCaseLabel: USE_CASES[useCaseKey],
        payload: { object: sourceObject, entry: { id: entryId, time: entryTime }, change }
      });
    }
  }

  return events;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

function serveStatic(res, pathname) {
  const filePath = pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, pathname);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(publicDir)) return sendText(res, 403, "Forbidden");

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    const fallback = path.join(publicDir, "index.html");
    const html = fs.readFileSync(fallback);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime });
  fs.createReadStream(resolved).pipe(res);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const asText = raw.toString("utf8");
      const parsed = safeJsonParse(asText, null);
      if (asText && parsed === null) {
        reject(new Error("Invalid JSON body"));
        return;
      }
      resolve({ raw, parsed: parsed || {} });
    });

    req.on("error", reject);
  });
}

function hasValidMetaSignature(req, rawBody) {
  if (!APP_SECRET) return true;

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const expected = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
  const provided = signatureHeader.trim();

  return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Hub-Signature-256"
    });
    return res.end();
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { status: "ok", app: "connektly-meta-webhook-server", timestamp: new Date().toISOString() });
  }

  if (req.method === "GET" && pathname === "/meta/webhook") {
    const mode = requestUrl.searchParams.get("hub.mode");
    const token = requestUrl.searchParams.get("hub.verify_token");
    const challenge = requestUrl.searchParams.get("hub.challenge") || "";

    if (mode === "subscribe" && token === VERIFY_TOKEN) return sendText(res, 200, challenge);
    return sendJson(res, 403, { error: "Verification failed", expectedTokenHint: "Set META_VERIFY_TOKEN in your environment" });
  }

  if (req.method === "POST" && pathname === "/meta/webhook") {
    try {
      const { raw, parsed } = await parseRequestBody(req);

      if (!hasValidMetaSignature(req, raw)) {
        return sendJson(res, 401, { error: "Invalid X-Hub-Signature-256 signature" });
      }

      const events = flattenPayloadToEvents(parsed);
      eventStore.addMany(events);

      return sendJson(res, 200, {
        received: true,
        acceptedEvents: events.length,
        useCases: [...new Set(events.map((event) => event.useCaseKey))],
        receivedAt: new Date().toISOString()
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    return sendJson(res, 200, eventStore.stats());
  }

  if (req.method === "GET" && pathname === "/api/events") {
    const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 50), 200);
    const type = requestUrl.searchParams.get("type") || undefined;
    const source = requestUrl.searchParams.get("source") || undefined;

    return sendJson(res, 200, {
      events: eventStore.all({ type, source, limit }),
      useCases: USE_CASES,
      sources: [...new Set(eventStore.events.map((event) => event.sourceObject))]
    });
  }

  if (req.method === "GET") return serveStatic(res, pathname);

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Connektly webhook server running on http://localhost:${PORT}`);
});
