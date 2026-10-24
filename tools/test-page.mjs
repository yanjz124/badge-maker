// Headless browser check of docs/: serves the folder, loads the page in Chrome, waits
// for a build, screenshots the front/3D/batch views and downloads a file.
// Usage: node tools/test-page.mjs [outDir]   (set SITE_URL to test a deployed site instead)
import { createServer } from "node:http";
import { readFile, mkdir, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve("docs");
const OUT = resolve(process.argv[2] || "tools/out/page");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff": "font/woff", ".txt": "text/plain" };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(0);
const url = process.env.SITE_URL || `http://127.0.0.1:${server.address().port}/`;
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const problems = [];
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });

  const waitBuilt = async () => {
    await page.waitForFunction(() => /badges? ·/.test(document.querySelector("#buildInfo")?.textContent || ""), { timeout: 60000 });
  };
  await page.goto(url, { waitUntil: "networkidle0" });
  await waitBuilt();
  console.log("single:", await page.$eval("#buildInfo", (e) => e.textContent));
  await page.screenshot({ path: join(OUT, "1-single.png"), fullPage: true });

  // Live update: type a name and wait for the rebuild.
  await page.click("#line1", { clickCount: 3 });
  await page.type("#line1", "SISTER DESAUTELS");
  await new Promise((r) => setTimeout(r, 400));
  await waitBuilt();
  await page.screenshot({ path: join(OUT, "2-typed.png"), clip: await (await page.$(".layout-preview")).boundingBox() });

  await page.click('[data-view="3d"]');
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: join(OUT, "3-3d.png"), clip: await (await page.$(".preview-box")).boundingBox() });

  await page.click('[data-view="front"]');
  await page.click('[data-mode="batch"]');
  await new Promise((r) => setTimeout(r, 400));
  await waitBuilt();
  console.log("batch:", await page.$eval("#buildInfo", (e) => e.textContent));
  await page.screenshot({ path: join(OUT, "4-batch.png"), clip: await (await page.$(".layout-preview")).boundingBox() });

  // Download in each format.
  for (const fmt of ["bambu", "prusa", "stlcolors"]) {
    await page.select("#format", fmt);
    await page.click("#download");
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (const f of await readdir(OUT)) if (!f.endsWith(".png")) console.log("downloaded", f, (await stat(join(OUT, f))).size, "bytes");

  await page.setViewport({ width: 390, height: 844 });
  await page.click('[data-mode="single"]');
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: join(OUT, "5-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`mobile horizontal overflow: ${overflow}px`);
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors");
process.exit(problems.length ? 1 : 0);
