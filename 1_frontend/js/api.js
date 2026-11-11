// 1. Automatically detect if running on GitHub Pages vs Local Machine
const IS_GITHUB_PAGES = window.location.hostname.includes("github.io");

// 2. Define data endpoints
// - Local Docker Backend (FastAPI + PostgreSQL)
const LOCAL_API_URL = "http://localhost:8000/api/dashboard";

// - Optional: If you later deploy FastAPI to Render/Railway/Cloud, put the HTTPS URL here:
const CLOUD_API_URL = ""; 

// - Static Gold JSON snapshot inside your repo (works 100% on GitHub Pages)
const STATIC_JSON_URL = new URL("./js/mock_data.json", window.location.href).href;

async function loadDashboardData() {
  const statusBadge = document.getElementById("connection-status");

  // CASE A: Running on Localhost (or if you configured a public HTTPS Cloud API)
  const activeApiUrl = !IS_GITHUB_PAGES ? LOCAL_API_URL : CLOUD_API_URL;

  if (activeApiUrl) {
    try {
      const response = await fetch(activeApiUrl, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error("Backend API not ready");
      const data = await response.json();

      statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block mr-1.5"></span>Live PostgreSQL + Spark API`;
      statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
      return data;
    } catch (err) {
      console.warn("Live API unreachable, falling back to Gold JSON snapshot:", err.message);
    }
  }

  // CASE B: Running on GitHub Pages (godsmartdog.github.io) or Local Fallback
  try {
    const snapshotResponse = await fetch(STATIC_JSON_URL, { cache: "no-store" });
    if (!snapshotResponse.ok) throw new Error(`HTTP ${snapshotResponse.status}`);
    const snapshotData = await snapshotResponse.json();

    if (IS_GITHUB_PAGES) {
      statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block mr-1.5"></span>GitHub Pages • Gold Lakehouse Snapshot`;
      statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30";
    } else {
      statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 inline-block mr-1.5"></span>Local Snapshot Mode (Docker Offline)`;
      statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30";
    }
    return snapshotData;
  } catch (err) {
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-400 inline-block mr-1.5"></span>Error Loading Data`;
    statusBadge.className = "text-xs font-semibold px-3 py-1 rounded-full bg-red-500/20 text-red-300 border border-red-500/30";
    console.error("Failed to load dashboard data:", err);
  }
}
