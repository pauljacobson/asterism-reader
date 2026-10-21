import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { seal, unseal } from "./security.js";

/** Pin account data and OAuth credentials to the deployment that created them. */
export function bindDeployment(db: Store, config: Config) {
  const expected = { origin: config.origin, wordpress: config.wordpress };
  db.atomic(() => {
    const row = db.get("SELECT value FROM secrets WHERE name='deployment'");
    if (row) {
      const saved = unseal<typeof expected>(row.value, config.key);
      if (
        saved.origin !== expected.origin ||
        saved.wordpress !== expected.wordpress
      )
        throw new Error(
          "This database belongs to a different APP_ORIGIN or WORDPRESS_URL. Restore its original configuration or use a new database for a new deployment.",
        );
      return;
    }
    // Older databases have no binding. Their first upgrade must retain the
    // original endpoints; subsequent starts enforce this record before serving.
    db.run(
      "INSERT INTO secrets(name,value) VALUES('deployment',?)",
      seal(expected, config.key),
    );
  });
}
