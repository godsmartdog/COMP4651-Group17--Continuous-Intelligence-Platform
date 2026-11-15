const IS_GITHUB_PAGES = window.location.hostname.includes("github.io");
const LOCAL_API_URL = "http://localhost:8000/api/dashboard";
const CLOUD_API_URL = "";
const STATIC_JSON_URL = new URL("./js/mock_data.json", window.location.href).href;

async function loadDashboardData(username = "") {
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  const baseApi = !IS_GITHUB_PAGES ? LOCAL_API_URL : CLOUD_API_URL;

  if (baseApi) {
    try {
      const url = username ? `${baseApi}?username=${encodeURIComponent(username)}` : baseApi;
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error("API unavailable");
      const data = await response.json();

      if (dot) dot.className = "status-dot";
      if (label) label.textContent = "PostgreSQL + Spark Live";
      return data;
    } catch (_) {
      // Fallback to static snapshot
    }
  }

  const snapshotResponse = await fetch(STATIC_JSON_URL, { cache: "no-store" });
  const snapshotData = await snapshotResponse.json();

  if (dot) dot.className = "status-dot snapshot";
  if (label) {
    label.textContent = IS_GITHUB_PAGES ? "Gold Snapshot · GitHub Pages" : "Gold Snapshot · Local";
  }
  return snapshotData;
}
