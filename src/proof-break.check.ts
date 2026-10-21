// Guard for issue #10 / #14: the deliberate "break main" artifacts from the
// Phase D self-healing proof (src/proof-break*.ts) must never re-land on main,
// or they fail `npm run build`. Run via: npm run check:proof-break
import assert from "node:assert";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Runs from dist/ after compilation, so resolve back to the source dir.
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Artifacts from the Phase D proof (issue #8 -> proof-break.ts,
// issue #12 -> proof-break2.ts). Each is a deliberate type error.
for (const artifact of ["proof-break.ts", "proof-break2.ts"]) {
  assert.ok(
    !existsSync(join(srcDir, artifact)),
    `src/${artifact} must not exist: it is a deliberate type error that fails \`npm run build\``,
  );
}

console.log("proof-break guard passed");
