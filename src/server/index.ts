// Database and future backup files are private to the runtime account.
process.umask(0o077);
import { configuration } from "./config.js";
import { createApp } from "./app.js";
const config = configuration();
const { app, db, logger } = createApp(config);
const server = app.listen(config.port, "0.0.0.0", () =>
  logger.write("started", "info", { port: config.port }),
);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const cleanup = setInterval(() => {
  try {
    db.cleanup();
    logger.cleanup();
  } catch {
    logger.write("maintenance", "error", { reason: "unexpected" });
  }
}, 60_000);
cleanup.unref();
process.on("SIGTERM", () => {
  logger.write("stopping");
  clearInterval(cleanup);
  server.close(() => {
    db.db.close();
    logger.close();
    process.exit(0);
  });
});
