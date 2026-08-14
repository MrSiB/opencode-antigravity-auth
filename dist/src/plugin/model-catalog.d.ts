/**
 * Live cache of the public Gemini API model catalog (`GET
 * generativelanguage.googleapis.com/v1beta/models`), sourced from the same
 * `fetchGeminiApiModels` call already made for `provider.models()` discovery.
 *
 * This is the documented, stable, Google-maintained model registry — unlike
 * the Antigravity Code Assist internal backend ids (`gemini-3-flash-agent`,
 * `gemini-pro-agent`, ...), which are reverse-engineered and have repeatedly
 * drifted (multiple upstream PRs have each guessed differently at the right
 * id). Routing decisions that ask "does the public API actually serve this
 * model id" should prefer this live data over a hardcoded allow/deny list,
 * which can only ever reflect what was true when it was last edited.
 */
import type { GeminiApiModel } from "./config/models";
/**
 * Records a freshly-fetched public Gemini API model list. Called as a side
 * effect of the existing model-discovery fetch — no extra network round trip.
 */
export declare function recordPublicGeminiApiModels(models: GeminiApiModel[]): void;
/**
 * Returns the live set of public Gemini API model ids, or `undefined` when no
 * catalog has been fetched yet (cold start) or the cached one is stale.
 * Callers should fall back to static heuristics in the `undefined` case.
 */
export declare function getPublicGeminiApiModelIds(): ReadonlySet<string> | undefined;
export declare function resetPublicGeminiApiModelCatalogForTests(): void;
//# sourceMappingURL=model-catalog.d.ts.map