import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const projectRoot = path.resolve(root, "..");
const leadLogFile = path.join(projectRoot, "output", "audit-requests.jsonl");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const auditEmailTo = process.env.AUDIT_REQUEST_EMAIL_TO || "dovid@sysmatic.ai";
const auditFormEndpoint = process.env.AUDIT_REQUEST_FORM_ENDPOINT || "";
const auditWebhookUrl = process.env.AUDIT_REQUEST_WEBHOOK_URL || "";
const asanaToken = process.env.ASANA_ACCESS_TOKEN || "";
const asanaWorkspaceGid = process.env.ASANA_WORKSPACE_GID || "";
const asanaAssigneeGid = process.env.ASANA_ASSIGNEE_GID || "";
const asanaProjectGid = process.env.ASANA_PROJECT_GID || "";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function cleanPath(url) {
  const pathname = new URL(url, `http://${host}:${port}`).pathname;
  return decodeURIComponent(pathname).replace(/^\/+/, "");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveFile(requestUrl) {
  const requested = cleanPath(requestUrl);
  const candidate = path.resolve(root, requested);
  if (!candidate.startsWith(root)) return null;

  if (await exists(candidate)) {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
    if (info.isDirectory()) {
      const indexFile = path.join(candidate, "index.html");
      if (await exists(indexFile)) return indexFile;
    }
  }

  const directoryIndex = path.join(candidate, "index.html");
  if (await exists(directoryIndex)) return directoryIndex;

  return path.join(root, "index.html");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function auditRequestFormData(record) {
  const form = new FormData();
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  form.append("_subject", "New Sysmatic systems audit request");
  form.append("_template", "table");
  form.append("_replyto", String(record.email || ""));
  form.append("_captcha", "false");
  return form;
}

async function deliverAuditRequest(record) {
  const deliveries = ["local-log"];

  if (asanaToken && asanaWorkspaceGid) {
    const name = String(record.name || "Unknown lead").trim();
    const company = String(record.company || "").trim();
    const taskName = `Sysmatic audit request: ${company || name}`;
    const notes = [
      "New Sysmatic systems audit request",
      "",
      `Name: ${name}`,
      `Email: ${record.email || ""}`,
      record.phone ? `Phone: ${record.phone}` : "",
      company ? `Company: ${company}` : "",
      record.tools ? `Tools: ${record.tools}` : "",
      "",
      "Biggest bottleneck:",
      record.bottleneck || "",
      "",
      `Submitted: ${record.submittedAt || record.receivedAt || new Date().toISOString()}`,
      `Source: ${record.source || "sysmatic-contact"}`,
    ].filter(Boolean).join("\n");
    const data = {
      name: taskName,
      notes,
      workspace: asanaWorkspaceGid,
      assignee: asanaAssigneeGid || undefined,
      projects: asanaProjectGid ? [asanaProjectGid] : undefined,
    };
    const asanaResponse = await fetch("https://app.asana.com/api/1.0/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${asanaToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data }),
    });
    if (!asanaResponse.ok) {
      const detail = await asanaResponse.text().catch(() => "");
      throw new Error(`Asana delivery failed: ${asanaResponse.status} ${detail.slice(0, 240)}`);
    }
    deliveries.push("asana-task");
  }

  if (auditWebhookUrl) {
    const webhookResponse = await fetch(auditWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!webhookResponse.ok) {
      throw new Error(`Webhook delivery failed: ${webhookResponse.status}`);
    }
    deliveries.push("webhook");
  }

  if (auditFormEndpoint) {
    const formResponse = await fetch(auditFormEndpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: auditRequestFormData(record),
    });
    if (!formResponse.ok) {
      throw new Error(`Email delivery failed: ${formResponse.status}`);
    }
    deliveries.push("email");
  }

  return deliveries;
}

async function handleAuditRequest(request, response) {
  try {
    const rawBody = await readBody(request);
    const contentType = request.headers["content-type"] || "";
    const acceptsHtml = String(request.headers.accept || "").includes("text/html");
    const data = contentType.includes("application/json")
      ? JSON.parse(rawBody || "{}")
      : Object.fromEntries(new URLSearchParams(rawBody));
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim();
    const bottleneck = String(data.bottleneck || "").trim();
    const website = String(data.website || data._honey || "").trim();

    if (website) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!name || !email.includes("@") || bottleneck.length < 12) {
      if (acceptsHtml) {
        response.writeHead(303, { location: "/contact" });
        response.end();
        return;
      }
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "name, email, and bottleneck are required" }));
      return;
    }

    const record = { ...data, receivedAt: new Date().toISOString(), source: "sysmatic-live-preview" };
    await mkdir(path.dirname(leadLogFile), { recursive: true });
    await appendFile(
      leadLogFile,
      `${JSON.stringify(record)}\n`,
    );
    const deliveries = await deliverAuditRequest(record);
    if (acceptsHtml && !contentType.includes("application/json")) {
      response.writeHead(303, { location: "/contact#request-received" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, deliveries }));
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "submission failed" }));
  }
}

createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", `http://${host}:${port}`).pathname;
  if (request.method === "POST" && pathname === "/api/audit-requests") {
    await handleAuditRequest(request, response);
    return;
  }

  const file = await resolveFile(request.url || "/");
  if (!file) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const ext = path.extname(file);
  const headers = {
    "content-type": contentTypes[ext] || "application/octet-stream",
    "cache-control":
      ext === ".html" ? "no-store, no-cache, max-age=0, must-revalidate" : "public, max-age=31536000, immutable",
  };
  if (ext === ".html") {
    headers.pragma = "no-cache";
    headers.expires = "0";
    headers["x-sysmatic-content"] = "deep-homepage-v4";
  }
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
}).listen(port, host, () => {
  console.log(`Serving dist at http://${host}:${port}/`);
});
