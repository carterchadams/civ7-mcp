// Loopback HTTP peer for the XHR transport probe: answers GET /ping with a JSON body and logs every request.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.argv[2] ?? 7789);
const log = (e: Record<string, unknown>) => { const line = JSON.stringify({ at: new Date().toISOString(), ...e }); appendFileSync("build/http-probe.log", line + "\n"); console.log(line); };
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
  req.on("end", () => {
    log({ event: "request", method: req.method, url: req.url, headers: req.headers, body: body.slice(0, 200) });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ ok: true, echo: body || null, url: req.url, at: Date.now() }));
  });
}).listen(port, "127.0.0.1", () => log({ event: "listening", port }));
