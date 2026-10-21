import { createSetup } from "./setup.mjs";

const [origin, wordpress] = process.argv.slice(2);
if (!origin || !wordpress || process.argv.length !== 4)
  throw new Error(
    "Usage: npm run setup:production -- https://reader.example.com https://wordpress.example.com",
  );
await createSetup({ origin, wordpress, production: true });
console.log(
  "Production configuration created in work/production.env. Install it securely on your host, attach persistent storage, and open the private 24-hour invitation in work/production-setup-url.txt after deployment. Existing local configuration is unchanged.",
);
