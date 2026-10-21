// Guard for issue #10: the deliberate "break main" artifact from the Phase D
// self-healing proof (src/proof-break.ts) must never re-land on main, or it
// fails `npm run build`. Run via: npm run check:proof-break
import assert from "node:assert";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Runs from dist/ after compilation, so resolve back to the source dir.
const here = dirname(fileURLToPath(import.meta.url));
const artifact = join(here, "..", "src", "proof-break.ts");

assert.ok(
  !existsSync(artifact),
  "src/proof-break.ts must not exist: it is a deliberate type error that fails `npm run build`",
);

console.log("proof-break guard passed");
