/**
 * voice-mcp-mossland - Minimal test server
 */
import http from "node:http";

const PORT = process.env.PORT || 3000;
console.log(`Starting voice-mcp-mossland on port ${PORT}...`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("voice-mcp-mossland running\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`voice-mcp-mossland running on port ${PORT}`);
});
