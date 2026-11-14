let forecastChartInstance = null;
let eventChartInstance = null;
let benchmarkChartInstance = null;
let globalDashboardData = null;
let activeUser = CURRENT_USER;
let currentScope = "MY_STACK";

let tempSelectedTags = new Set();
let tempSelectedGoals = new Set();

function getClusterBadge(cluster) {
  const styles = {
    "Viral Breakout": "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    "High Momentum": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    "Steady Mature": "bg-zinc-800 text-zinc-300 border-zinc-700",
    "Bot Anomaly": "bg-red-500/15 text-red-300 border-red-500/30"
  };
  return `<span class="px-2 py-0.5 text-[11px] font-medium rounded-md border ${styles[cluster] || styles["Steady Mature"]}">${cluster}</span>`;
}

// ============================================================================
// DISCORD-STYLE ONBOARDING MODAL LOGIC
// ============================================================================
function openOnboardingModal() {
  tempSelectedTags = new Set(activeUser.selected_tags?.length ? activeUser.selected_tags : ["ai-llm", "python"]);
  tempSelectedGoals = new Set(activeUser.signal_goals?.length ? activeUser.signal_goals : ["viral"]);

  renderOnboardingOptions();
  document.getElementById("onboarding-modal").classList.remove("hidden");
}

function renderOnboardingOptions() {
  const tagsGrid = document.getElementById("onboarding-tags-grid");
  tagsGrid.innerHTML = AVAILABLE_TAGS.map(tag => {
    const isSelected = tempSelectedTags.has(tag.id);
    return `
      <button type="button" onclick="toggleTempTag('${tag.id}')"
        class="tag-pill ${isSelected ? "selected" : ""}">
        <span>${tag.icon}</span>
        <span>${tag.label}</span>
        ${isSelected ? '<span class="text-indigo-300 text-xs ml-0.5">✓</span>' : ""}
      </button>
    `;
  }).join("");

  const goalsGrid = document.getElementById("onboarding-goals-grid");
  goalsGrid.innerHTML = SIGNAL_GOALS.map(g => {
    const isSelected = tempSelectedGoals.has(g.id);
    return `
      <div onclick="toggleTempGoal('${g.id}')" class="goal-card ${isSelected ? "selected" : ""}">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-zinc-100">${g.title}</span>
          <span class="text-xs ${isSelected ? "text-indigo-400" : "text-zinc-600"}">${isSelected ? "●" : "○"}</span>
        </div>
        <p class="text-[11px] text-zinc-400 mt-1 leading-snug">${g.desc}</p>
      </div>
    `;
  }).join("");

  const matchedCount = (globalDashboardData?.emerging_repos || []).filter(r =>
    (r.tags || []).some(t => tempSelectedTags.has(t))
  ).length;
  document.getElementById("onboarding-match-preview").textContent =
    `${tempSelectedTags.size} tags · Matches ${matchedCount} breakout repos`;
}

function toggleTempTag(tagId) {
  if (tempSelectedTags.has(tagId)) tempSelectedTags.delete(tagId);
  else tempSelectedTags.add(tagId);
  renderOnboardingOptions();
}

function toggleTempGoal(goalId) {
  if (tempSelectedGoals.has(goalId)) tempSelectedGoals.delete(goalId);
  else tempSelectedGoals.add(goalId);
  renderOnboardingOptions();
}

function saveOnboardingChoices() {
  const chosenTags = tempSelectedTags.size > 0 ? Array.from(tempSelectedTags) : ["ai-llm", "data-spark"];
  const chosenGoals = tempSelectedGoals.size > 0 ? Array.from(tempSelectedGoals) : ["viral"];

  activeUser = completeUserOnboarding(chosenTags, chosenGoals);
  document.getElementById("onboarding-modal").classList.add("hidden");
  refreshAllUserViews();
}

function skipOnboardingDefault() {
  activeUser = completeUserOnboarding(["ai-llm", "data-spark", "python"], ["viral"]);
  document.getElementById("onboarding-modal").classList.add("hidden");
  refreshAllUserViews();
}

// ============================================================================
// WORKSPACE RENDERING
// ============================================================================
function mergeWatchlistIntoRepos(data) {
  const existingNames = new Set(data.emerging_repos.map(r => r.repo_name));
  (activeUser.watchlist || []).forEach((repoName, i) => {
    if (!existingNames.has(repoName)) {
      data.emerging_repos.push({
        rank: data.emerging_repos.length + 1,
        repo_name: repoName,
        description: "Synced directly from your public GitHub starred repositories.",
        language: "GitHub Starred",
        tags: activeUser.selected_tags?.length ? [activeUser.selected_tags[0]] : ["python"],
        signal_type: "viral",
        stars_24h: 64 + i * 22,
        forks_24h: 11 + i * 4,
        pushes_24h: 24 + i * 6,
        baseline_avg_7d: 18.5,
        momentum_z_score: +(7.4 - i * 0.6).toFixed(2),
        ml_cluster: "High Momentum",
        predicted_stars_7d: 420 + i * 110,
        hourly_history: [15, 22, 30, 38, 46, 55, 64 + i * 22],
        ml_forecast: [95, 150, 210, 280, 350, 420 + i * 110]
      });
    }
  });
}

function computeRepoAffinity(repo) {
  const userTags = activeUser.selected_tags || [];
  const userGoals = activeUser.signal_goals || [];
  const overlap = (repo.tags || []).filter(t => userTags.includes(t)).length;
  const goalBonus = userGoals.includes(repo.signal_type) ? 0.5 : 0;
  return overlap + goalBonus;
}

function renderSidebarAndHeader(data) {
  if (activeUser.avatar) {
    document.getElementById("sidebar-avatar").src = activeUser.avatar;
  }
  document.getElementById("sidebar-username").textContent = `@${activeUser.username}`;
  document.getElementById("sidebar-footprint").textContent = activeUser.footprint_status || "Active";
  document.getElementById("sidebar-watch-count").textContent = (activeUser.watchlist || []).length;
  document.getElementById("cold-start-pill").textContent = activeUser.footprint_status || "";

  const tagMap = Object.fromEntries(AVAILABLE_TAGS.map(t => [t.id, t]));
  const userTags = activeUser.selected_tags || [];
  document.getElementById("sidebar-tags").innerHTML = userTags.map(id => {
    const t = tagMap[id] || { icon: "#", label: id };
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-[#161922] border border-[#252a36] text-zinc-300">
      <span>${t.icon}</span><span>${t.label}</span>
    </span>`;
  }).join("");

  document.getElementById("kpi-user-events").textContent = activeUser.events_quota || "1,290,400";
  document.getElementById("kpi-events").textContent = data.kpis.total_events_processed;
  document.getElementById("kpi-bots").textContent = data.kpis.bot_traffic_filtered_pct;
  document.getElementById("kpi-latency").textContent = data.kpis.incremental_latency_min;
  document.getElementById("kpi-speedup").textContent = `${data.kpis.speedup_factor} faster`;
  document.getElementById("kpi-tag-count").textContent = `${userTags.length} Active`;
  document.getElementById("last-updated").textContent = `Batch ${data.kpis.last_batch_hour}`;

  const rankedForUser = [...data.emerging_repos]
    .map(r => ({ ...r, affinity: computeRepoAffinity(r) }))
    .filter(r => userTags.length === 0 || r.affinity > 0)
    .sort((a, b) => (b.affinity * 10 + b.momentum_z_score) - (a.affinity * 10 + a.momentum_z_score));

  const topRecs = (rankedForUser.length ? rankedForUser : data.emerging_repos).slice(0, 3);
  const tagLabels = Object.fromEntries(AVAILABLE_TAGS.map(t => [t.id, t.label]));

  document.getElementById("als-cards").innerHTML = topRecs.map((r, i) => {
    const matchedTagNames = (r.tags || [])
      .filter(t => userTags.includes(t))
      .map(t => tagLabels[t] || t);
    const matchPct = Math.min(99.4, 91.5 + r.affinity * 3.2 - i * 1.4).toFixed(1);

    return `
      <div onclick="selectRepositoryByName('${r.repo_name}')"
        class="saas-panel p-4 cursor-pointer hover:border-indigo-500/60 transition flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-zinc-100 truncate">${r.repo_name}</span>
            <span class="text-[11px] font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded shrink-0">
              ${matchPct}% match
            </span>
          </div>
          <p class="text-[11px] text-zinc-400 mt-1.5 line-clamp-2 leading-relaxed">${r.description || r.language}</p>
        </div>
        <div class="flex items-center justify-between mt-3 pt-2.5 border-t border-[#1c2029] text-[11px]">
          <span class="text-zinc-500 truncate">${matchedTagNames.length ? "Matched: " + matchedTagNames.join(", ") : r.language}</span>
          <span class="font-mono text-emerald-400 shrink-0">+${r.stars_24h} ★</span>
        </div>
      </div>
    `;
  }).join("");
}

function getScopedRepos() {
  const query = document.getElementById("repo-search").value.toLowerCase();
  const userTags = activeUser.selected_tags || [];

  return globalDashboardData.emerging_repos.filter(r => {
    const matchesSearch =
      r.repo_name.toLowerCase().includes(query) ||
      r.language.toLowerCase().includes(query);
    if (!matchesSearch) return false;

    if (currentScope === "MY_STACK") {
      return userTags.length === 0 || (r.tags || []).some(t => userTags.includes(t));
    }
    if (currentScope === "WATCHLIST") {
      return (activeUser.watchlist || []).includes(r.repo_name);
    }
    return true;
  });
}

function setFeedScope(scope) {
  currentScope = scope;
  const titles = {
    MY_STACK: "For You · Personalized Tag & ALS Feed",
    GLOBAL: "Global Stream · All Breakout Repositories",
    WATCHLIST: `Watchlist · Saved Repositories (@${activeUser.username})`
  };
  document.getElementById("page-title").textContent = titles[scope];
  document.getElementById("table-heading").textContent = titles[scope];

  ["MY_STACK", "GLOBAL", "WATCHLIST"].forEach(s => {
    const el = document.getElementById(`nav-${s}`);
    if (el) el.classList.toggle("active", s === scope);
  });

  const repos = renderLeaderboard();
  if (repos.length > 0) selectRepositoryByName(repos[0].repo_name);
}

function handleStarClick(event, repoName) {
  event.stopPropagation();
  activeUser = toggleWatchlistRepo(repoName);
  document.getElementById("sidebar-watch-count").textContent = activeUser.watchlist.length;
  renderLeaderboard();
}

function renderLeaderboard() {
  const repos = getScopedRepos();
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  if (repos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-xs text-zinc-500">
          No matching repositories. <button onclick="openOnboardingModal()" class="text-indigo-400 underline ml-1">Adjust your tags</button>
        </td>
      </tr>`;
    return [];
  }

  repos.forEach((repo, idx) => {
    const isStarred = (activeUser.watchlist || []).includes(repo.repo_name);
    const tr = document.createElement("tr");
    tr.className = `repo-row ${idx === 0 ? "active-row" : ""}`;
    tr.dataset.repo = repo.repo_name;
    tr.onclick = () => selectRepositoryByName(repo.repo_name);

    tr.innerHTML = `
      <td class="py-3 pl-4 pr-2">
        <button onclick="handleStarClick(event, '${repo.repo_name}')"
          class="text-sm ${isStarred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-300"}">★</button>
      </td>
      <td class="py-3 px-3">
        <div class="font-medium text-zinc-100">${repo.repo_name}</div>
        <div class="text-[11px] text-zinc-500">${repo.language}</div>
      </td>
      <td class="py-3 px-3 text-right font-mono text-zinc-200">+${repo.stars_24h.toLocaleString()}</td>
      <td class="py-3 px-3 text-right font-mono font-medium text-emerald-400">${repo.momentum_z_score.toFixed(2)}</td>
      <td class="py-3 px-3">${getClusterBadge(repo.ml_cluster)}</td>
      <td class="py-3 pl-3 pr-4 text-right font-mono text-indigo-300">+${repo.predicted_stars_7d.toLocaleString()}</td>
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
  document.getElementById("selected-repo-desc").textContent = repo.description || "Tracked via hourly GH Archive Silver Parquet partitions.";
  document.getElementById("inspector-lang").textContent = repo.language;
  document.getElementById("insp-baseline").textContent = `${repo.baseline_avg_7d}/d`;
  document.getElementById("insp-forks").textContent = `+${repo.forks_24h}`;
  document.getElementById("insp-pushes").textContent = repo.pushes_24h;

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
          borderColor: "#e4e4e7",
          backgroundColor: "rgba(228, 228, 231, 0.06)",
          borderWidth: 2,
          pointRadius: 2,
          fill: true,
          tension: 0.3
        },
        {
          label: "GBT 7d Forecast",
          data: [null, null, null, null, null, null, repo.hourly_history[6], ...repo.ml_forecast],
          borderColor: "#818cf8",
          borderDash: [5, 4],
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#a1a1aa", boxWidth: 10, font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: "#71717a", font: { size: 10 } }, grid: { color: "#181b22" } },
        y: { ticks: { color: "#71717a", font: { size: 10 } }, grid: { color: "#181b22" } }
      }
    }
  });
}

function renderStaticCharts(data) {
  if (eventChartInstance) eventChartInstance.destroy();
  eventChartInstance = new Chart(document.getElementById("eventDistChart"), {
    type: "doughnut",
    data: {
      labels: data.event_distribution.labels,
      datasets: [{
        data: data.event_distribution.shares,
        backgroundColor: ["#6366f1", "#10b981", "#3b82f6", "#f59e0b", "#71717a"],
        borderColor: "#111318",
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: { position: "right", labels: { color: "#a1a1aa", boxWidth: 10, font: { size: 11 } } }
      }
    }
  });

  if (benchmarkChartInstance) benchmarkChartInstance.destroy();
  benchmarkChartInstance = new Chart(document.getElementById("benchmarkChart"), {
    type: "bar",
    data: {
      labels: data.benchmarks.horizons,
      datasets: [
        {
          label: "Full Batch Rescan (min)",
          data: data.benchmarks.full_recompute_min,
          backgroundColor: "#27272a",
          borderColor: "#3f3f46",
          borderWidth: 1,
          borderRadius: 4
        },
        {
          label: "Incremental Lakehouse (min)",
          data: data.benchmarks.incremental_pipeline_min,
          backgroundColor: "#6366f1",
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#a1a1aa", boxWidth: 10, font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: "#71717a", font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: "#71717a", font: { size: 10 } }, grid: { color: "#181b22" } }
      }
    }
  });
}

function refreshAllUserViews() {
  renderSidebarAndHeader(globalDashboardData);
  const repos = renderLeaderboard();
  if (repos.length > 0) selectRepositoryByName(repos[0].repo_name);
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!activeUser) return;
  globalDashboardData = await loadDashboardData(activeUser.username);
  mergeWatchlistIntoRepos(globalDashboardData);
  renderStaticCharts(globalDashboardData);
  refreshAllUserViews();

  // Trigger Discord-style onboarding automatically for any first-time / cold-start user
  if (!activeUser.onboarding_completed) {
    openOnboardingModal();
  }

  document.getElementById("repo-search").addEventListener("input", renderLeaderboard);
});
