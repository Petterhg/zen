import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../prototypes/zen-workbench/", import.meta.url);
const types = {
  "/": "text/html",
  "/index.html": "text/html",
  "/style.css": "text/css",
  "/app.js": "text/javascript",
};
const port = Number(process.env.ZEN_PROTOTYPE_PORT || 4317);
const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!Object.hasOwn(types, url.pathname)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    try {
      const bytes = await readFile(
        fileURLToPath(
          new URL(
            url.pathname === "/" ? "index.html" : url.pathname.slice(1),
            root,
          ),
        ),
      );
      res.writeHead(200, {
        "Content-Type": types[url.pathname] + "; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(bytes);
    } catch {
      res.writeHead(500);
      res.end("Could not load prototype");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      `Zen workbench prototype: http://127.0.0.1:${server.address().port}`,
    ),
  );
