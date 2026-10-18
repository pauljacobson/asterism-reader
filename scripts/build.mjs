import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
await mkdir("dist/public/assets", { recursive: true });
const result = await build({
  entryPoints: ["src/client/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "app.js",
  minify: true,
  write: false,
});
const js = result.outputFiles[0].contents,
  css = await readFile("public/style.css");
const appPath = `/assets/app-${hash(js)}.js`,
  stylePath = `/assets/style-${hash(css)}.css`;
await writeFile("dist/public" + appPath, js);
await writeFile("dist/public" + stylePath, css);
// Stable aliases retain compatibility with previously loaded browser pages.
await writeFile("dist/public/app.js", js);
await writeFile("dist/public/style.css", css);
const html = (await readFile("public/index.html", "utf8"))
  .replace("/app.js", appPath)
  .replace("/style.css", stylePath);
await writeFile("dist/public/index.html", html);
await cp("public/icons", "dist/public/icons", { recursive: true });
const resources = ["manifest.webmanifest", "offline.html", "offline.css"];
for (const name of resources)
  await copyFile("public/" + name, "dist/public/" + name);
const assets = [
  appPath,
  stylePath,
  "/offline.html",
  "/offline.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/asterism.svg",
];
// Changes to any static resource or worker code produce a new update version.
const sw = await readFile("public/sw.js", "utf8");
const version = hash(
  Buffer.concat([
    Buffer.from(html),
    Buffer.from(sw),
    ...(await Promise.all(
      [...assets, ...resources.map((name) => "/" + name)].map((name) =>
        readFile("dist/public" + name),
      ),
    )),
  ]),
);
await writeFile(
  "dist/public/sw.js",
  sw
    .replace("__VERSION__", version)
    .replace("__ASSETS__", JSON.stringify(assets)),
);
