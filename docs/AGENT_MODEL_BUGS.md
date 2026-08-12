# Troubleshooting Agent Model Selection (Blank UI)

## The \ Выберите агента и модель\ (Choose agent and model) Issue

If you launch OpenCode and receive a blank popup saying \Выберите агента и модель перед отправкой запроса\ with an empty dropdown list, this means the Desktop UI failed to resolve the default model assigned to your agents.

### Root Cause
Historically, models were defined with tiers appended to their IDs (e.g., \google/antigravity-gemini-3.6-flash-high\). In the newer variants system, the model ID is strictly \google/antigravity-gemini-3.6-flash\, and the tier is passed as a variant option.

If your \/root/.config/opencode/opencode.json\ (or workspace config) still contains legacy IDs in the \gent\ section:
\\\json
  \agent\: {
    \sisyphus\: {
      \model\: \google/antigravity-gemini-3.6-flash-high\
    }
  }
\\\
The OpenCode client will fail to map the agent's model to the available models list, causing the dropdown menu to break and render empty.

### How to Fix
To fix this, you must strip the \-high\, \-medium\, \-low\, or \-minimal\ suffixes from the \gent\ model assignments.

1. Open \/root/.config/opencode/opencode.json\ and any workspace \.opencode/opencode.json\.
2. Locate the \\agent\\ object.
3. Change any legacy model string (e.g., \google/antigravity-gemini-3.6-flash-high\) to its base ID (\google/antigravity-gemini-3.6-flash\).
4. Restart the OpenCode web server: \systemctl restart opencode-web --force\
5. Refresh the browser tab (F5).

*Note: The \pply_desktop_gemini_fix.py\ script has been updated to handle this automatically when patching configurations.*
