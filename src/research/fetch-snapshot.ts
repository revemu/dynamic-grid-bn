import { loadOrFetchSnapshot } from "./data.js";

async function main() {
  const args = process.argv.slice(2);
  let days = 15;
  let endIso = "2026-10-29T00:00:00.000Z";
  let topN = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--end" && args[i + 1]) {
      endIso = args[i + 1]!;
      if (!endIso.endsWith("Z") && !endIso.includes("+")) endIso += "Z";
      i++;
    } else if (args[i] === "--top" && args[i + 1]) {
      topN = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  console.log(`=== Fetching Deterministic Research Snapshot ===`);
  console.log(`Days: ${days}`);
  console.log(`End Cutoff: ${endIso}`);
  console.log(`Top liquid pairs: ${topN}`);

  const t0 = Date.now();
  const snapshot = await loadOrFetchSnapshot({ days, endIso, topN });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n================ Summary ================`);
  console.log(`Duration: ${elapsedSec}s`);
  console.log(`Passed symbols: ${snapshot.manifest.passedSymbols.length}`);
  console.log(`Rejected symbols: ${snapshot.manifest.rejectedSymbols.length}`);

  if (snapshot.manifest.passedSymbols.includes("HAEDALUSDT")) {
    console.log(`✓ Required coin HAEDALUSDT is present and verified!`);
  } else {
    console.error(`🚨 CRITICAL: HAEDALUSDT failed data quality check or was not found!`);
    process.exit(1);
  }

  if (snapshot.manifest.passedSymbols.length < 25) {
    console.error(`🚨 Gate P1 Failed: Only ${snapshot.manifest.passedSymbols.length} coins passed (minimum 25 required)`);
    process.exit(1);
  }

  console.log(`🎉 Acceptance Gate P1 PASSED!`);
}

main().catch((err) => {
  console.error("Fatal error fetching snapshot:", err);
  process.exit(1);
});
