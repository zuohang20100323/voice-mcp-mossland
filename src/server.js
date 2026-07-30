/**
 * voice-mcp-mossland — MCP TTS server (Mossland engine)
 *
 * Endpoints:
 *   /                 → docs HTML
 *   /status           → JSON status
 *   /speak?text=...   → GET TTS audio (wav)
 *   /mcp              → MCP SSE transport (GET → SSE, POST → message)
 */

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;

const ENGINE = process.env.TTS_ENGINE || "mossland";

const MOSSLAND_BASE_URL = process.env.MOSSLAND_BASE_URL || "https://api.mosi.cn/v1";
const MOSSLAND_API_KEY  = process.env.MOSSLAND_API_KEY  || "";
const MOSSLAND_VOICE_ID = process.env.MOSSLAND_VOICE_ID || "1f4af4c7-eb64-49c3-bc72-de9c6ff585bc";
const MOSSLAND_TTS_MODEL= process.env.MOSSLAND_TTS_MODEL  || "moss-tts";
const BOT_NAME = process.env.CHARACTER_NAME || "S.CHI";

/* ------------------------------------------------------------------ */
/*  Mossland TTS                                                       */
/* ------------------------------------------------------------------ */

function mosslandTTS(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MOSSLAND_TTS_MODEL,
      input: text,
      voice: MOSSLAND_VOICE_ID,
      response_format: "wav",
    });

    const url = new URL(MOSSLAND_BASE_URL);
    const lib = url.protocol === "http:" ? http : https;

    const basePath = url.pathname.replace(/\/+$/, "");
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: basePath + "/audio/speech",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MOSSLAND_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 200) {
          resolve({ ok: true, audio: buf, contentType: res.headers["content-type"] || "audio/wav" });
        } else {
          reject(new Error(`TTS API ${res.statusCode}: ${buf.toString("utf8").slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  MCP Server                                                         */
/* ------------------------------------------------------------------ */

const mcpServer = new Server(
  { name: "voice-mcp-mossland", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "speak",
      description: "Convert text to speech using Mossland TTS engine. Returns audio data.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak aloud" },
        },
        required: ["text"],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = request.params.arguments?.text;
  if (!text || typeof text !== "string") {
    return { content: [{ type: "text", text: "Missing or invalid 'text' argument" }], isError: true };
  }

  try {
    const result = await mosslandTTS(text);
    return {
      content: [
        { type: "text", text: `TTS generated: ${text.length} chars → ${result.audio.length} bytes` },
        { type: "resource", resource: { uri: "data:audio/wav;base64," + result.audio.toString("base64"), mimeType: "audio/wav" } },
      ],
    };
  } catch (err) {
    return { content: [{ type: "text", text: `TTS failed: ${err.message}` }], isError: true };
  }
});

/* ------------------------------------------------------------------ */
/*  Transport tracking                                                 */
/* ------------------------------------------------------------------ */

const transports = new Map();

function getTransport(sessionId) {
  if (sessionId && transports.has(sessionId)) {
    return transports.get(sessionId);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

function htmlResponse(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const DOCS_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>voice-mcp-mossland</title>
<style>
body{font-family:system-ui;max-width:620px;margin:40px auto;padding:20px;color:#333;line-height:1.7}
h1{color:#07c160}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:.9em}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto}
</style></head>
<body>
<h1>🎙️ voice-mcp-mossland</h1>
<p>MCP TTS server — Mossland engine</p>
<p>Bot: <strong>${BOT_NAME}</strong></p>
<h3>Endpoints</h3>
<ul>
<li><code>/</code> — this page</li>
<li><code>/status</code> — JSON status</li>
<li><code>/speak?text=Hello</code> — TTS audio (GET, wav)</li>
<li><code>/mcp</code> — MCP SSE transport</li>
</ul>
<h3>Kelivo config</h3>
<p>Add an MCP server in Kelivo:</p>
<ul>
<li><strong>URL:</strong> <code>https://voice-mcp-mossland-production.up.railway.app</code></li>
<li><strong>Transport:</strong> SSE</li>
<li><strong>Endpoint:</strong> <code>/mcp</code></li>
</ul>
</body></html>`;

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                       */
/* ------------------------------------------------------------------ */

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    /* GET / — docs */
    if (req.method === "GET" && path === "/") {
      return htmlResponse(res, DOCS_PAGE);
    }

    /* GET /status */
    if (req.method === "GET" && path === "/status") {
      return jsonResponse(res, {
        ok: true,
        service: "voice-mcp-mossland",
        engine: ENGINE,
        voice_id: MOSSLAND_VOICE_ID,
        model: MOSSLAND_TTS_MODEL,
        bot: BOT_NAME,
        sse_endpoint: "/mcp",
      });
    }

    /* GET /speak?text=... */
    if (req.method === "GET" && path === "/speak") {
      const text = url.searchParams.get("text") || "";
      if (!text) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Missing 'text' query parameter");
      }

      mosslandTTS(text)
        .then((result) => {
          res.writeHead(200, {
            "Content-Type": result.contentType || "audio/wav",
            "Content-Length": result.audio.length,
            "Cache-Control": "no-cache",
          });
          res.end(result.audio);
        })
        .catch((err) => {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`TTS error: ${err.message}`);
        });
      return;
    }

    /* /mcp — SSE transport */
    if (path === "/mcp") {
      if (req.method === "GET") {
        /* New SSE session */
        const transport = new SSEServerTransport("/mcp", res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        req.on("close", () => {
          transports.delete(sessionId);
          try { transport.close(); } catch { /* ignore */ }
        });

        mcpServer.connect(transport).catch((err) => {
          console.error("MCP connect error:", err.message);
          transports.delete(sessionId);
          try { res.end(); } catch { /* ignore */ }
        });
        return;
      }

      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = JSON.parse(body); } catch { /* use raw */ }

          /* Try to find sessionId from the JSON-RPC message */
          const sessionId = url.searchParams.get("sessionId") || parsed?.sessionId || null;
          const transport = getTransport(sessionId);

          if (!transport) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("No active SSE session for this sessionId");
          }

          transport.handlePostMessage(req, res, body).catch((err) => {
            console.error("MCP POST error:", err.message);
            if (!res.headersSent) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end(`MCP error: ${err.message}`);
            }
          });
        });
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain" });
      return res.end("Method Not Allowed");
    }

    /* 404 */
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (err) {
    console.error("Unhandled error:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`voice-mcp-mossland running on port ${PORT}`);
  console.log(`Engine: ${ENGINE} | Bot: ${BOT_NAME} | Model: ${MOSSLAND_TTS_MODEL}`);
});
