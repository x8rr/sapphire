// Test harness: a minimal Scramjet host app with Sapphire wired in, plus a
// second origin serving test pages and zipped test extensions.
//
//   host  http://localhost:5199   vite (harness app) + wisp at /wisp/
//   site  http://127.0.0.1:5200   static test pages, /ext/<name>.zip
//
// The site is deliberately a different origin from the host so everything
// reaches it through the proxy, exactly like a real site would.
import { createServer as createVite } from "vite";
import { build as esbuild } from "esbuild";
import http from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const nm = join(root, "node_modules/@mercuryworkshop");

export const HOST_PORT = Number(process.env.HOST_PORT ?? 5199);
export const SITE_PORT = Number(process.env.SITE_PORT ?? 5200);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

const STATIC = {
  "/scramjet/scramjet.js": join(nm, "scramjet/dist/scramjet.js"),
  "/scramjet/scramjet.wasm": join(nm, "scramjet/dist/scramjet.wasm"),
  "/controller/controller.inject.js": join(nm, "scramjet-controller/dist/controller.inject.js"),
  "/controller/controller.sw.js": join(nm, "scramjet-controller/dist/controller.sw.js"),
  "/controller/controller.api.js": join(nm, "scramjet-controller/dist/controller.api.js"),
};

async function buildSapphireSw() {
  const result = await esbuild({
    entryPoints: [join(root, "src/router/swEntry.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

async function zipDir(dir) {
  const zip = new JSZip();
  const walk = async (rel) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(r);
      else zip.file(r, await readFile(join(dir, r)));
    }
  };
  await walk("");
  return zip.generateAsync({ type: "nodebuffer" });
}

function siteHandler(req, res) {
  (async () => {
    const url = new URL(req.url, `http://127.0.0.1:${SITE_PORT}`);
    const extMatch = url.pathname.match(/^\/ext\/([\w-]+)\.zip$/);
    if (extMatch) {
      const dir = join(root, "test/extensions", extMatch[1]);
      const body = await zipDir(dir);
      res.writeHead(200, { "Content-Type": "application/zip", "Access-Control-Allow-Origin": "*" });
      res.end(body);
      return;
    }
    if (url.pathname === "/echo") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ headers: req.headers, url: req.url }));
      return;
    }
    if (url.pathname === "/set-cookie") {
      res.writeHead(200, { "Set-Cookie": `${url.searchParams.get("name") ?? "a"}=${url.searchParams.get("value") ?? "1"}; Path=/`, "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    let path = join(root, "test/site", decodeURIComponent(url.pathname));
    try {
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      const body = await readFile(path);
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  })().catch((e) => {
    res.writeHead(500);
    res.end(String(e));
  });
}

export async function startServers() {
  logging.set_level(logging.WARN);
  wisp.options.allow_loopback_ips = true;
  wisp.options.allow_private_ips = true;

  const vite = await createVite({
    root: join(here, "web"),
    configFile: false,
    logLevel: "warn",
    server: { port: HOST_PORT, strictPort: true, hmr: false, fs: { allow: [root] } },
    optimizeDeps: { exclude: ["@mercuryworkshop/libcurl-transport"] },
    plugins: [
      {
        name: "sapphire-harness-static",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const pathname = (req.url ?? "").split("?")[0];
            try {
              if (pathname === "/sapphire-sw-router.js") {
                res.setHeader("Content-Type", "application/javascript");
                res.end(await buildSapphireSw());
                return;
              }
              if (pathname.startsWith("/api/crx/")) {
                const id = pathname.slice("/api/crx/".length);
                if (!/^[a-p]{32}$/.test(id)) throw new Error("bad extension id");
                const r = await fetch(`https://clients2.google.com/service/update2/crx?response=redirect&prodversion=138.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`);
                res.statusCode = r.status;
                res.setHeader("Content-Type", "application/octet-stream");
                res.end(Buffer.from(await r.arrayBuffer()));
                return;
              }
              if (pathname === "/api/fetch") {
                const target = new URL(req.url, "http://x").searchParams.get("url");
                const r = await fetch(target);
                res.statusCode = r.status;
                res.setHeader("Content-Type", "application/octet-stream");
                res.end(Buffer.from(await r.arrayBuffer()));
                return;
              }
              const file = STATIC[pathname];
              if (file) {
                res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
                res.end(await readFile(file));
                return;
              }
            } catch (e) {
              res.statusCode = 500;
              res.end(String(e));
              return;
            }
            next();
          });
        },
      },
    ],
  });
  await vite.listen();
  vite.httpServer.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  });

  const site = http.createServer(siteHandler);
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

  return {
    hostUrl: `http://localhost:${HOST_PORT}/`,
    siteUrl: `http://127.0.0.1:${SITE_PORT}/`,
    async close() {
      await vite.close();
      await new Promise((r) => site.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServers();
  console.log(`\nSapphire dev browser:  ${s.hostUrl}\n(test site on ${s.siteUrl})\n`);
}
