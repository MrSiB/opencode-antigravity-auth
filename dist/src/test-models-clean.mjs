import { readFileSync } from "fs";

async function test() {
  const accountsFile = JSON.parse(readFileSync("/root/.config/opencode/antigravity-accounts.json", "utf8"));
  const acc = accountsFile.accounts.find(a => a.email === "krakensk76@gmail.com");
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
  
  const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
    },
    body: JSON.stringify({ project: acc.managedProjectId }),
  });
  
  console.log("Status:", response.status);
  const data = await response.json();
  console.log("Models:", JSON.stringify(data, null, 2));
}

test().catch(console.error);
