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

      dot.className = "w-2 h-2 rounded-full bg-emerald-400";
      label.textContent = "PostgreSQL + Spark Live";
      return data;
    } catch (_) {
      // Fall through to Gold JSON snapshot
    }
  }

  const snapshotResponse = await fetch(STATIC_JSON_URL, { cache: "no-store" });
  const snapshotData = await snapshotResponse.json();

  if (IS_GITHUB_PAGES) {
    dot.className = "w-2 h-2 rounded-full bg-indigo-400";
    label.textContent = "Gold Snapshot · GitHub Pages";
  } else {
    dot.className = "w-2 h-2 rounded-full bg-amber-400";
    label.textContent = "Gold Snapshot · Local Mode";
  }
  return snapshotData;
}
