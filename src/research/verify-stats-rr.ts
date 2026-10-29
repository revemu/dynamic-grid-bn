import assert from "assert";
import { spearman, clusterBootstrapStat, meanExcludingLargestNegatives } from "./stats.js";

console.log("--- Starting Acceptance Gate R2: Statistical Tools Verification ---");

// Test 1: Spearman perfect positive
{
  const r = spearman([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.strictEqual(r, 1, `spearman([1,2,3,4],[1,2,3,4]) should be 1, got ${r}`);
  console.log("✓ Test 1 Passed: spearman perfect positive = 1");
}

// Test 2: Spearman perfect negative
{
  const r = spearman([1, 2, 3, 4], [4, 3, 2, 1]);
  assert.strictEqual(r, -1, `spearman([1,2,3,4],[4,3,2,1]) should be -1, got ${r}`);
  console.log("✓ Test 2 Passed: spearman perfect negative = -1");
}

// Test 3: Spearman tied ranks
{
  const r = spearman([1, 2, 2, 4], [2, 3, 3, 5]);
  assert.strictEqual(r, 1, `spearman with matching tied ranks should be 1, got ${r}`);
  console.log("✓ Test 3 Passed: spearman handles tied ranks correctly");
}

// Test 4: meanExcludingLargestNegatives
{
  const val = meanExcludingLargestNegatives([-5, -4, -3, 1, 2], 2);
  assert.ok(Math.abs(val - 0) < 1e-6, `meanExcludingLargestNegatives([-5,-4,-3,1,2], 2) should be 0, got ${val}`);
  console.log("✓ Test 4 Passed: meanExcludingLargestNegatives cuts 2 largest negative values");
}

// Test 5: clusterBootstrapStat
{
  const clusters = new Map<string, number[]>();
  clusters.set("C1", [1, 2, 3]);
  clusters.set("C2", [4, 5, 6]);
  clusters.set("C3", [7, 8, 9]);

  const res = clusterBootstrapStat(clusters, (vals) => vals.reduce((a, b) => a + b, 0) / vals.length, 1000, 0.9, 42);
  assert.strictEqual(res.value, 5, `mean should be 5, got ${res.value}`);
  assert.ok(res.lower < 5 && res.upper > 5, `CI should surround 5, got [${res.lower}, ${res.upper}]`);
  console.log(`✓ Test 5 Passed: clusterBootstrapStat works as expected (value=${res.value}, CI=[${res.lower}, ${res.upper}])`);
}

console.log("🎉 ALL TESTS PASSED ACCEPTANCE GATE R2!");
