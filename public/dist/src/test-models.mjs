import { getAntigravityHeaders } from "./constants.js";
import { parseRefreshParts } from "./plugin/auth.js";
import { refreshAccessToken } from "./plugin/token.js";

async function test() {
  const accountsFile = await import("/root/.config/opencode/antigravity-accounts.json", {
    assert: { type: "json" }
  });
  const acc = accountsFile.default.accounts.find(a => a.email === "krakensk76@gmail.com");
  const rt = acc.refreshToken;
  
  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      client_secret: "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",
      refresh_token: rt,
      grant_type: "refresh_token"
    })
  });
  const token = (await refreshRes.json()).access_token;
  console.log("Token:", !!token);

  const endpoint = "https://cloudcode-pa.googleapis.com";
  const quotaUserAgent = getAntigravityHeaders()["User-Agent"] || "antigravity/windows/amd64";
  const body = acc.managedProjectId ? { project: acc.managedProjectId } : {};
  
  const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": quotaUserAgent,
      ...getAntigravityHeaders()
    },
    body: JSON.stringify(body),
  });
  
  console.log("Status:", response.status);
  const data = await response.json();
  console.log("Models:", JSON.stringify(data, null, 2));
}

test().catch(console.error);
