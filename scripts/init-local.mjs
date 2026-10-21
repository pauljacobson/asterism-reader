import { createSetup } from "./setup.mjs";

const wordpress = process.argv[2];
if (!wordpress || process.argv.length !== 3)
  throw new Error(
    "Usage: npm run setup:local -- https://your-wordpress-site.example",
  );
await createSetup({ origin: "http://localhost:4320", wordpress });
console.log(
  "Local configuration created in .env. Open the private 24-hour invitation in work/local-setup-url.txt. Use separate configuration and a permanent HTTPS hostname for production.",
);
