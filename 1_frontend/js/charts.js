let eventChartInstance = null;
let benchmarkChartInstance = null;
let forecastChartInstance = null;
let globalDashboardData = null;

function getClusterBadge(cluster) {
  const styles = {
    "Viral Breakout": "bg-purple-500/20 text-purple-300 border-purple-500/40",
    "High Momentum": "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    "Steady Mature": "bg-blue-500/20 text-blue-300 border-blue-500/40",
    "Bot / Spam Anomaly": "bg-red-500/20 text-red-300 border-red-500/40"
  };
  const cls = styles[cluster] || "bg-slate-700 text-slate-300";
  return `<span class="px-2.5 py-0.5 text-xs font-semibold rounded-full border ${cls}">${cluster}</span>`;
}

function renderKPIs(kpis) {
  document.getElementById("kpi-events").textContent = kpis.total_events_processed;
  document.getElementById("kpi-repos").textContent = kpis.active_repos_tracked;
  document.getElementById("kpi-bots").textContent = kpis.bot_traffic_filtered_pct;
  document.getElementById("kpi-latency").textContent = kpis.incremental_latency_min;
  document.getElementById("kpi-speedup").textContent = kpis.speedup_factor;
  document.getElementById("last-updated").textContent = `Last Hourly Batch: ${kpis.last_batch_hour}`;
}

function renderLeaderboard(repos) {
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  repos.forEach((repo, idx) => {
    const tr = document.createElement("tr");
    tr.className = `repo-row border-b border-slate-800 ${idx === 0 ? "active-row" : ""}`;
    tr.onclick = () => selectRepository(idx);

    tr.innerHTML = `
      <td class="py-3 px-4 font-bold text-slate-400">#${repo.rank}</td>
      <td class="py-3 px-4">
        <div class="font-bold text-white">${repo.repo_name}</div>
        <div class="text-xs text-slate-400">${repo.language}</div>
      </td>
      <td class="py-3 px-4 text-right font-mono text-amber-300">+${repo.stars_24h.toLocaleString()}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-300">${repo.baseline_avg_7d}/d</td>
      <td class="py-3 px-4 text-right">
        <span class="font-mono font-bold text-emerald-400">${repo.momentum_z_score.toFixed(2)}</span>
      </td>
      <td class="py-3 px-4 text-center">${getClusterBadge(repo.ml_cluster)}</td>
      <td class="py-3 px-4 text-right font-mono text-purple-300">+${repo.predicted_stars_7d.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function selectRepository(index) {
  const rows = document.querySelectorAll(".repo-row");
  rows.forEach((r, i) => r.classList.toggle("active-row", i === index));

  const repo = globalDashboardData.emerging_repos[index];
  document.getElementById("selected-repo-title").textContent = `${repo.repo_name} — 7-Day ML Trajectory`;
  document.getElementById("selected-repo-subtitle").textContent =
    `Z-Score: ${repo.momentum_z_score} | Cluster: ${repo.ml_cluster} | 24h Pushes: ${repo.pushes_24h}`;

  const ctx = document.getElementById("forecastChart").getContext("2d");
  if (forecastChartInstance) forecastChartInstance.destroy();

  const labels = ["Day -6", "Day -5", "Day -4", "Day -3", "Day -2", "Yesterday", "Today (24h)", "ML +1d", "ML +2d", "ML +3d", "ML +4d", "ML +5d", "ML +7d"];
  const historicalData = [...repo.hourly_history, null, null, null, null, null, null];
  const forecastData = [null, null, null, null, null, null, repo.hourly_history[6], ...repo.ml_forecast];

  forecastChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Observed Cumulative Stars (Silver/Gold)",
          data: historicalData,
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.15)",
          borderWidth: 3,
          fill: true,
          tension: 0.35
        },
        {
          label: "Spark MLlib GBT 7-Day Forecast",
          data: forecastData,
          borderColor: "#c084fc",
          borderDash: [6, 4],
          backgroundColor: "rgba(192, 132, 252, 0.1)",
          borderWidth: 3,
          fill: true,
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1" } } },
      scales: {
        x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.1)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.1)" } }
      }
    }
  });
}

function renderStaticCharts(data) {
  // Part 2: Event Distribution Chart
  const eventCtx = document.getElementById("eventDistChart").getContext("2d");
  eventChartInstance = new Chart(eventCtx, {
    type: "doughnut",
    data: {
      labels: data.event_distribution.labels,
      datasets: [{
        data: data.event_distribution.shares,
        backgroundColor: ["#3b82f6", "#10b981", "#a855f7", "#ec4899", "#06b6d4"],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#cbd5e1", boxWidth: 12, font: { size: 11 } } }
      }
    }
  });

  // Part 3: Incremental vs Full Recompute Benchmark Chart
  const benchCtx = document.getElementById("benchmarkChart").getContext("2d");
  benchmarkChartInstance = new Chart(benchCtx, {
    type: "bar",
    data: {
      labels: data.benchmarks.horizons,
      datasets: [
        {
          label: "Full Batch Recompute (min)",
          data: data.benchmarks.full_recompute_min,
          backgroundColor: "rgba(239, 68, 68, 0.75)",
          borderRadius: 6
        },
        {
          label: "Incremental Lakehouse Pipeline (min)",
          data: data.benchmarks.incremental_pipeline_min,
          backgroundColor: "rgba(16, 185, 129, 0.85)",
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1" } } },
      scales: {
        x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.1)" }, title: { display: true, text: "Execution Time (Minutes)", color: "#94a3b8" } }
      }
    }
  });
}

function filterRepositories() {
  const query = document.getElementById("repo-search").value.toLowerCase();
  const cluster = document.getElementById("cluster-filter").value;
  const filtered = globalDashboardData.emerging_repos.filter(r => {
    const matchesName = r.repo_name.toLowerCase().includes(query) || r.language.toLowerCase().includes(query);
    const matchesCluster = cluster === "ALL" || r.ml_cluster === cluster;
    return matchesName && matchesCluster;
  });
  renderLeaderboard(filtered);
}

window.addEventListener("DOMContentLoaded", async () => {
  globalDashboardData = await loadDashboardData();
  renderKPIs(globalDashboardData.kpis);
  renderLeaderboard(globalDashboardData.emerging_repos);
  renderStaticCharts(globalDashboardData);
  selectRepository(0);

  document.getElementById("repo-search").addEventListener("input", filterRepositories);
  document.getElementById("cluster-filter").addEventListener("change", filterRepositories);
});
