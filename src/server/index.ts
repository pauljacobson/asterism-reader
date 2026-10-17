// Database and future backup files are private to the runtime account.
process.umask(0o077);
import { configuration } from "./config.js";
import { createApp } from "./app.js";
const config = configuration();
const { app, db } = createApp(config);
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`Asterism Reader listening on port ${config.port}`),
);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const cleanup = setInterval(() => db.cleanup(), 60_000);
cleanup.unref();
process.on("SIGTERM", () => {
  clearInterval(cleanup);
  server.close(() => {
    db.db.close();
    process.exit(0);
  });
});
