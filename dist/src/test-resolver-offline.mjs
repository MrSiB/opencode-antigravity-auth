import { resolveModelWithTier } from './plugin/transform/model-resolver.js';
import { loadAccounts } from './plugin/storage.js';
import assert from 'node:assert';

console.log("Running offline model resolver tests...");

const testCases = [
  {
    input: "antigravity-claude-sonnet-4-6-thinking-high",
    expected: {
      actualModel: "claude-sonnet-4-6-thinking",
      isThinkingModel: true,
      thinkingBudget: 32768
    }
  },
  {
    input: "antigravity-claude-opus-4-6-thinking-low",
    expected: {
      actualModel: "claude-opus-4-6-thinking",
      isThinkingModel: true,
      thinkingBudget: 8192
    }
  },
  {
    input: "antigravity-gemini-3.5-flash-medium",
    expected: {
      actualModel: (val) => val === "gemini-3.5-flash" || val === "gemini-3.5-flash-medium",
      thinkingLevel: "medium"
    }
  },
  {
    input: "antigravity-gpt-oss-120b-medium",
    expected: {
      actualModel: "gpt-oss-120b-medium"
    }
  }
];

for (const { input, expected } of testCases) {
  console.log(`\nTesting: ${input}`);
  const result = resolveModelWithTier(input);
  console.log("Result:", JSON.stringify(result, null, 2));
  
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (typeof expectedValue === 'function') {
      assert.ok(
        expectedValue(result[key]),
        `For ${input}, validation failed for ${key}, got ${result[key]}`
      );
    } else {
      assert.strictEqual(
        result[key],
        expectedValue,
        `For ${input}, expected ${key} to be ${expectedValue}, but got ${result[key]}`
      );
    }
  }
}

console.log("\nTesting loadAccounts from sandbox...");
const loaded = await loadAccounts();
console.log("Loaded accounts count:", loaded ? loaded.accounts.length : 0);
assert.ok(loaded && loaded.accounts.length > 0, "No accounts loaded from sandbox!");

console.log("\nAll tests passed successfully!");
