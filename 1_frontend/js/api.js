const IS_GITHUB_PAGES = window.location.hostname.includes("github.io");
const LOCAL_API_URL = "http://localhost:8000/api/dashboard";
const CLOUD_API_URL = ""; // Optional: Add Render/Railway HTTPS URL later
const STATIC_JSON_URL = new URL("./js/mock_data.json", window.location.href).href;

async function loadDashboardData(username = "") {
  const statusBadge = document.getElementById("connection-status");
  const baseApi = !IS_GITHUB_PAGES ? LOCAL_API_URL : CLOUD_API_URL;

  if (baseApi) {
    try {
      const url = username ? `${baseApi}?username=${encodeURIComponent(username)}` : baseApi;
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error("Backend API not ready");
      const data = await response.json();

      statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>Live PostgreSQL + Spark API`;
      statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
      return data;
    } catch (err) {
      console.warn("Live API offline, loading Gold snapshot JSON:", err.message);
    }
  }

  const snapshotResponse = await fetch(STATIC_JSON_URL, { cache: "no-store" });
  const snapshotData = await snapshotResponse.json();

  if (IS_GITHUB_PAGES) {
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block mr-1.5"></span>GitHub Pages • Gold Lakehouse Snapshot`;
    statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30";
  } else {
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 inline-block mr-1.5"></span>Local Snapshot Mode (Docker Offline)`;
    statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30";
  }
  return snapshotData;
}
