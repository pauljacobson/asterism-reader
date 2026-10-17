import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/public", { recursive: true });
await build({
  entryPoints: ["src/client/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/public/app.js",
  minify: true,
});
for (const name of ["index.html", "style.css"])
  await copyFile("public/" + name, "dist/public/" + name);
