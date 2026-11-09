// Entry point: node scripts/kill-tests.mjs
import { runKillTests, waitForLocalReturn } from "./killTests.mjs";
import { writeFile } from "node:fs/promises";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYEE_EMAIL, PAYPAL_API_BASE, CURRENCY } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYEE_EMAIL) {
  console.error("Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYEE_EMAIL (the freelancer's sandbox business email).");
  process.exit(1);
}
const base = PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
if (!base.includes("sandbox")) {
  console.error("Refusing to run: PAYPAL_API_BASE is not a sandbox URL.");
  process.exit(1);
}

const report = await runKillTests({
  base,
  clientId: PAYPAL_CLIENT_ID,
  clientSecret: PAYPAL_CLIENT_SECRET,
  payeeEmail: PAYEE_EMAIL,
  currency: CURRENCY || "USD",
  waitForApproval: waitForLocalReturn(),
});
await writeFile("kill-tests-output.json", JSON.stringify(report, null, 2));
console.log("\n===== RESULTS =====");
for (const [k, v] of Object.entries(report.results)) console.log(`${k}: ${v}`);
console.log("\nFull responses saved to kill-tests-output.json. Paste the RESULTS above (and that file) to Claude.");
