// Disposable local acceptance server. This fixture is excluded from deployment.
import express from "express";
import { readFile } from "node:fs/promises";
const app = express();
let revision = 1;
app.get("/sw.js", async (_req, res) => {
  const source = (await readFile("dist/public/sw.js", "utf8")).replace(
    /asterism-static-([a-f0-9]+)/,
    `asterism-static-$1-test-${revision}`,
  );
  res.type("js").set("Cache-Control", "no-store").send(source);
});
app.post("/__test/update-worker", (_req, res) =>
  res.json({ revision: ++revision }),
);
app.use(express.static("dist/public", { maxAge: 0 }));
app.listen(4323, "127.0.0.1", () =>
  console.log("PWA acceptance fixture ready on 4323"),
);
