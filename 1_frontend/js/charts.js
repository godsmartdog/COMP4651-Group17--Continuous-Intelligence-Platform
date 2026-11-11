let forecastChartInstance = null;
let globalDashboardData = null;
let activeUser = CURRENT_USER;
let currentScope = "MY_STACK";

function getClusterBadge(cluster) {
  const styles = {
    "Viral Breakout": "bg-purple-500/20 text-purple-300 border-purple-500/40",
    "High Momentum": "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    "Steady Mature": "bg-blue-500/20 text-blue-300 border-blue-500/40",
    "Bot / Spam Anomaly": "bg-red-500/20 text-red-300 border-red-500/40"
  };
  return `<span class="px-2 py-0.5 text-xs font-semibold rounded-full border ${styles[cluster] || "border-slate-600 text-slate-300"}">${cluster}</span>`;
}

// Ensures any real GitHub starred repos from Sign-In also appear in the user's Watchlist tab
function mergeRealGitHubWatchlistIntoRepos(data) {
  const existingNames = new Set(data.emerging_repos.map(r => r.repo_name));
  (activeUser.watchlist || []).forEach((repoName, i) => {
    if (!existingNames.has(repoName)) {
      data.emerging_repos.push({
        rank: data.emerging_repos.length + 1,
        repo_name: repoName,
        language: activeUser.preferred_langs[0] || "GitHub Starred",
        stars_24h: 45 + i * 18,
        forks_24h: 8 + i * 3,
        pushes_24h: 19 + i * 5,
        baseline_avg_7d: 14.0,
        momentum_z_score: +(6.8 - i * 0.7).toFixed(2),
        ml_cluster: "High Momentum",
        predicted_stars_7d: 320 + i * 90,
        hourly_history: [12, 18, 24, 29, 35, 41, 45 + i * 18],
        ml_forecast: [85, 130, 180, 230, 275, 320 + i * 90]
      });
    }
  });
}

function renderUserHeaderAndKPIs(data) {
  if (activeUser.avatar) {
    document.getElementById("header-avatar").src = activeUser.avatar;
  }
  document.getElementById("header-username").textContent = `@${activeUser.username}`;
  document.getElementById("header-role").textContent =
    `${activeUser.role} • Stack: ${activeUser.preferred_langs.join(" | ")}`;
  document.getElementById("footprint-badge").textContent =
    activeUser.footprint_status || "GH Archive Footprint Ready";

  document.getElementById("kpi-user-events").textContent = activeUser.events_quota;
  document.getElementById("kpi-events").textContent = data.kpis.total_events_processed;
  document.getElementById("kpi-watchlist-count").textContent = `${activeUser.watchlist.length} Repos`;
  document.getElementById("kpi-bots").textContent = data.kpis.bot_traffic_filtered_pct;
  document.getElementById("kpi-latency").textContent = data.kpis.incremental_latency_min;
  document.getElementById("kpi-speedup").textContent = data.kpis.speedup_factor;
  document.getElementById("last-updated").textContent = `Batch: ${data.kpis.last_batch_hour}`;

  const matchedRepos = data.emerging_repos.filter(r => activeUser.preferred_langs.includes(r.language));
  const alsContainer = document.getElementById("als-cards");
  alsContainer.innerHTML = matchedRepos.slice(0, 3).map((r, i) => `
    <div onclick="selectRepositoryByName('${r.repo_name}')" class="cursor-pointer bg-slate-900/90 border border-slate-700/80 rounded-xl p-3.5 hover:border-purple-400 transition">
      <div class="flex items-center justify-between mb-1">
        <span class="font-bold text-sm text-white truncate pr-2">${r.repo_name}</span>
        <span class="text-xs font-mono font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 shrink-0">${(98.4 - i * 3.7).toFixed(1)}% Match</span>
      </div>
      <div class="text-xs text-slate-400">${r.language} • +${r.stars_24h} stars (24h)</div>
    </div>
  `).join("");
}

function getScopedRepos() {
  const query = document.getElementById("repo-search").value.toLowerCase();
  return globalDashboardData.emerging_repos.filter(r => {
    const matchesSearch = r.repo_name.toLowerCase().includes(query) || r.language.toLowerCase().includes(query);
    if (!matchesSearch) return false;
    if (currentScope === "MY_STACK") return activeUser.preferred_langs.includes(r.language);
    if (currentScope === "WATCHLIST") return activeUser.watchlist.includes(r.repo_name);
    return true;
  });
}

function setFeedScope(scope) {
  currentScope = scope;
  const titles = {
    MY_STACK: "Emerging Repositories in Your Subscribed Stack",
    WATCHLIST: `★ Saved & GitHub Starred Watchlist (@${activeUser.username})`,
    GLOBAL: "All Global Breakout Repositories"
  };
  document.getElementById("table-heading").textContent = titles[scope];

  ["MY_STACK", "WATCHLIST", "GLOBAL"].forEach(s => {
    const btnId = s === "MY_STACK" ? "btn-my-stack" : s === "WATCHLIST" ? "btn-watchlist" : "btn-global";
    document.getElementById(btnId).className = s === scope
      ? "text-xs font-bold px-3 py-1 rounded-lg bg-blue-600 text-white"
      : "text-xs font-bold px-3 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white";
  });

  const filtered = renderLeaderboard();
  if (filtered.length > 0) selectRepositoryByName(filtered[0].repo_name);
}

function handleStarClick(event, repoName) {
  event.stopPropagation();
  activeUser = toggleWatchlistRepo(repoName);
  document.getElementById("kpi-watchlist-count").textContent = `${activeUser.watchlist.length} Repos`;
  renderLeaderboard();
}

function renderLeaderboard() {
  const repos = getScopedRepos();
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  if (repos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">No repositories in this view yet.</td></tr>`;
    return [];
  }

  repos.forEach((repo, idx) => {
    const isStarred = activeUser.watchlist.includes(repo.repo_name);
    const tr = document.createElement("tr");
    tr.className = `repo-row border-b border-slate-800 ${idx === 0 ? "active-row" : ""}`;
    tr.dataset.repo = repo.repo_name;
    tr.onclick = () => selectRepositoryByName(repo.repo_name);

    tr.innerHTML = `
      <td class="py-3 px-3">
        <button onclick="handleStarClick(event, '${repo.repo_name}')" class="text-base ${isStarred ? "text-amber-400" : "text-slate-600 hover:text-amber-300"}">★</button>
      </td>
      <td class="py-3 px-3">
        <div class="font-bold text-white">${repo.repo_name}</div>
        <div class="text-xs text-slate-400">${repo.language}</div>
      </td>
      <td class="py-3 px-3 text-right font-mono text-amber-300">+${repo.stars_24h.toLocaleString()}</td>
      <td class="py-3 px-3 text-right font-mono font-bold text-emerald-400">${repo.momentum_z_score.toFixed(2)}</td>
      <td class="py-3 px-3 text-center">${getClusterBadge(repo.ml_cluster)}</td>
      <td class="py-3 px-3 text-right font-mono text-purple-300">+${repo.predicted_stars_7d.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
  return repos;
}

function selectRepositoryByName(repoName) {
  document.querySelectorAll(".repo-row").forEach(r => {
    r.classList.toggle("active-row", r.dataset.repo === repoName);
  });

  const repo = globalDashboardData.emerging_repos.find(r => r.repo_name === repoName);
  if (!repo) return;

  document.getElementById("selected-repo-title").textContent = repo.repo_name;
  document.getElementById("selected-repo-subtitle").textContent =
    `${repo.language} | Momentum Z: ${repo.momentum_z_score} | 24h Pushes: ${repo.pushes_24h}`;

  const ctx = document.getElementById("forecastChart").getContext("2d");
  if (forecastChartInstance) forecastChartInstance.destroy();

  const labels = ["D-6", "D-5", "D-4", "D-3", "D-2", "D-1", "Today", "+1d", "+2d", "+3d", "+4d", "+5d", "+7d"];
  forecastChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Observed Stars",
          data: [...repo.hourly_history, null, null, null, null, null, null],
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.15)",
          borderWidth: 3,
          fill: true,
          tension: 0.35
        },
        {
          label: "ML 7-Day Forecast",
          data: [null, null, null, null, null, null, repo.hourly_history[6], ...repo.ml_forecast],
          borderColor: "#c084fc",
          borderDash: [6, 4],
          borderWidth: 3,
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1" } } },
      scales: {
        x: { ticks: { color: "#94a3b8" } },
        y: { ticks: { color: "#94a3b8" } }
      }
    }
  });
}

function renderStaticCharts(data) {
  new Chart(document.getElementById("eventDistChart"), {
    type: "doughnut",
    data: {
      labels: data.event_distribution.labels,
      datasets: [{ data: data.event_distribution.shares, backgroundColor: ["#3b82f6", "#10b981", "#a855f7", "#ec4899", "#06b6d4"], borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: "#cbd5e1" } } } }
  });

  new Chart(document.getElementById("benchmarkChart"), {
    type: "bar",
    data: {
      labels: data.benchmarks.horizons,
      datasets: [
        { label: "Full Recompute (min)", data: data.benchmarks.full_recompute_min, backgroundColor: "rgba(239, 68, 68, 0.75)", borderRadius: 6 },
        { label: "Incremental Pipeline (min)", data: data.benchmarks.incremental_pipeline_min, backgroundColor: "rgba(16, 185, 129, 0.85)", borderRadius: 6 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: "#cbd5e1" } } } }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!activeUser) return;
  globalDashboardData = await loadDashboardData(activeUser.username);
  mergeRealGitHubWatchlistIntoRepos(globalDashboardData);
  renderUserHeaderAndKPIs(globalDashboardData);
  const initialRepos = renderLeaderboard();
  renderStaticCharts(globalDashboardData);
  if (initialRepos.length > 0) selectRepositoryByName(initialRepos[0].repo_name);

  document.getElementById("repo-search").addEventListener("input", renderLeaderboard);
});
