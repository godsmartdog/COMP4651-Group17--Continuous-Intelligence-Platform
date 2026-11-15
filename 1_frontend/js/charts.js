let modalForecastChart = null;
let inlineForecastChart = null;
let globalDashboardData = null;

let activeUser = CURRENT_USER;
let activeChannelFilter = "ALL";
let selectedGlobalRepo = null;

let tempSelectedTags = new Set();
let tempSelectedGoals = new Set();

const CURRENT_PAGE = document.body.dataset.page || "for-you";

const LANG_COLORS = {
  "Python / CUDA": "#3572A5",
  "Scala / Python": "#c22d40",
  "Rust": "#dea584",
  "Rust / Python": "#dea584",
  "TypeScript": "#3178c6",
  "Go / C": "#00ADD8",
  "Python / TypeScript": "#3572A5",
  "Shell": "#89e051",
  "GitHub Starred": "#f59e0b"
};

function getClusterBadge(cluster) {
  const map = {
    "Viral Breakout": "badge-viral",
    "High Momentum": "badge-momentum",
    "Steady Mature": "badge-mature",
    "Bot Anomaly": "badge-anomaly"
  };
  return `<span class="badge-cluster ${map[cluster] || "badge-mature"}">${cluster}</span>`;
}

function buildSparklineSVG(points, isAnomaly = false) {
  if (!points || points.length < 2) return "";
  const w = 92, h = 24, pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const stroke = isAnomaly ? "#dc2626" : "#059669";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${coords}"/></svg>`;
}

// ============================================================================
// 1. SHARED HORIZONTAL TOP NAVBAR + HORIZONTAL TAG STRIP
// ============================================================================
function renderSharedHorizontalNavbar() {
  const nav = document.getElementById("shared-navbar");
  if (!nav) return;

  const watchCount = (activeUser.watchlist || []).length;
  const avatarSrc = activeUser.avatar || "https://github.com/identicons/default.png";
  const footprintText = activeUser.footprint_status || "Spark Synced";

  nav.innerHTML = `
    <div class="top-navbar-inner">
      <div class="nav-left">
        <a href="./index.html" class="brand-link">
          <div class="auth-logo-mark">G</div>
          <span class="auth-brand-name">GitPulse</span>
          <span class="version-pill">v2.4</span>
        </a>

        <nav class="nav-links">
          <a href="./index.html" class="nav-link ${CURRENT_PAGE === "for-you" ? "active" : ""}">
            <span>✦ For You Feed</span>
          </a>
          <a href="./global.html" class="nav-link ${CURRENT_PAGE === "global" ? "active" : ""}">
            <span>🌐 Global Breakouts</span>
          </a>
          <a href="./watchlist.html" class="nav-link ${CURRENT_PAGE === "watchlist" ? "active" : ""}">
            <span>★ Watchlist</span>
            <span id="nav-watch-count" class="nav-count-badge">${watchCount}</span>
          </a>
          <a href="./benchmarks.html" class="nav-link ${CURRENT_PAGE === "benchmarks" ? "active" : ""}">
            <span>📊 Benchmarks &amp; EDA</span>
          </a>
        </nav>
      </div>

      <div class="nav-right">
        <div class="conn-pill">
          <span id="conn-dot" class="status-dot"></span>
          <span id="conn-label">Connecting...</span>
        </div>

        <div class="user-horizontal-chip">
          <img src="${avatarSrc}" onerror="this.src='https://github.com/identicons/default.png'" class="user-avatar-sm" alt="Avatar" />
          <div class="user-meta-inline">
            <span class="user-handle">@${activeUser.username}</span>
            <span class="user-footprint-tag">${footprintText}</span>
          </div>
        </div>

        <button type="button" onclick="signOut()" class="btn-signout">Sign Out</button>
      </div>
    </div>
  `;
}

function renderHorizontalTagStrip() {
  const strip = document.getElementById("shared-tag-strip");
  if (!strip) return;

  const tagMap = Object.fromEntries(AVAILABLE_TAGS.map(t => [t.id, t]));
  const userTags = activeUser.selected_tags || [];

  const allPill = `
    <button type="button" onclick="setChannelFilter('ALL')"
      class="channel-pill ${activeChannelFilter === "ALL" ? "active" : ""}">
      All Subscribed (${userTags.length})
    </button>
  `;

  const pills = userTags.map(id => {
    const t = tagMap[id];
    if (!t) return "";
    return `
      <button type="button" onclick="setChannelFilter('${id}')"
        class="channel-pill ${activeChannelFilter === id ? "active" : ""}">
        <span>${t.icon}</span>
        <span>${t.label}</span>
      </button>
    `;
  }).join("");

  strip.innerHTML = `
    <div class="horizontal-tag-strip-inner">
      <div class="tag-strip-list">
        <span class="tag-strip-label">Your Channels:</span>
        ${allPill}
        ${pills}
      </div>
      <button type="button" onclick="openOnboardingModal()" class="btn-edit-tags">
        <span># Customize Channels</span>
      </button>
    </div>
  `;
}

function setChannelFilter(tagId) {
  activeChannelFilter = tagId;
  renderHorizontalTagStrip();
  renderPageTable();
}

// ============================================================================
// 2. SHARED MODALS (DISCORD-STYLE ONBOARDING + 7-DAY FORECAST MODAL)
// ============================================================================
function injectSharedModals() {
  const host = document.getElementById("shared-modals");
  if (!host) return;

  host.innerHTML = `
    <!-- Discord-Style First-Time Channel & Tag Onboarding Modal -->
    <div id="onboarding-modal" class="modal-overlay hidden">
      <div class="modal-window">
        <div class="modal-top">
          <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:#4f46e5; letter-spacing:0.04em;">
            Welcome to GitPulse · Cold-Start Channel Setup
          </div>
          <h2 class="auth-card-title" style="margin-top:0.3rem;">Pick the channels you want to follow</h2>
          <p class="auth-card-subtitle" style="margin-top:0.3rem;">
            Since we haven't tracked your historical GH Archive footprint yet, choose your tech tags below to personalize your For You feed right away.
          </p>
        </div>

        <div class="modal-body">
          <div>
            <div class="input-label">1. Which ecosystems &amp; languages should appear in your horizontal bar?</div>
            <div id="onboarding-tags-grid" class="onboard-grid"></div>
          </div>
          <div>
            <div class="input-label">2. Which breakout signals matter most to you?</div>
            <div id="onboarding-goals-grid" class="onboard-grid"></div>
          </div>
        </div>

        <div class="modal-foot">
          <span id="onboarding-match-preview" class="font-mono" style="font-size:0.8rem; font-weight:600; color:#059669;"></span>
          <div style="display:flex; gap:0.65rem;">
            <button type="button" onclick="skipOnboardingDefault()" class="btn-auth-secondary">Use Defaults</button>
            <button type="button" onclick="saveOnboardingChoices()" class="btn-auth-primary btn-modal-submit">Save My Channels →</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Clean Light-Mode Repository Forecast Modal (For You & Watchlist Pages) -->
    <div id="forecast-modal" class="modal-overlay hidden" onclick="if(event.target===this) closeForecastModal()">
      <div class="modal-window" style="max-width:580px;">
        <div class="modal-top" style="display:flex; align-items:flex-start; justify-content:space-between; gap:1rem;">
          <div>
            <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem;">
              <span id="modal-lang" class="version-pill"></span>
              <span id="modal-cluster"></span>
            </div>
            <h2 id="modal-repo-name" class="auth-card-title" style="font-size:1.25rem;"></h2>
          </div>
          <button type="button" onclick="closeForecastModal()" class="auth-modal-close">✕</button>
        </div>

        <div class="modal-body">
          <p id="modal-repo-desc" class="auth-card-subtitle" style="margin:0;"></p>
          <div class="inspector-metrics-grid">
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">24h Stars</div>
              <div id="modal-stars" class="inspector-stat-val tabular-nums">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">7d Baseline</div>
              <div id="modal-baseline" class="inspector-stat-val tabular-nums">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">24h Forks</div>
              <div id="modal-forks" class="inspector-stat-val tabular-nums">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">24h Pushes</div>
              <div id="modal-pushes" class="inspector-stat-val tabular-nums">--</div>
            </div>
          </div>
          <div style="height:220px; position:relative;">
            <canvas id="modalForecastChart"></canvas>
          </div>
        </div>

        <div class="modal-foot">
          <span class="section-hint">Spark MLlib GBTRegressor 7-Day Projection</span>
          <a id="modal-gh-link" href="#" target="_blank" rel="noopener noreferrer" class="btn-auth-primary btn-modal-submit" style="text-decoration:none;">
            View Repository on GitHub ↗
          </a>
        </div>
      </div>
    </div>
  `;
}

function openOnboardingModal() {
  tempSelectedTags = new Set(activeUser.selected_tags?.length ? activeUser.selected_tags : ["ai-llm", "data-spark"]);
  tempSelectedGoals = new Set(activeUser.signal_goals?.length ? activeUser.signal_goals : ["viral"]);
  renderOnboardingOptions();
  document.getElementById("onboarding-modal")?.classList.remove("hidden");
}

function renderOnboardingOptions() {
  const repos = globalDashboardData?.emerging_repos || [];

  document.getElementById("onboarding-tags-grid").innerHTML = AVAILABLE_TAGS.map(tag => {
    const selected = tempSelectedTags.has(tag.id);
    return `
      <div onclick="toggleTempTag('${tag.id}')" class="onboard-option ${selected ? "selected" : ""}">
        <div>
          <div style="font-size:0.85rem; font-weight:700; color:#0f172a;">${tag.icon} ${tag.label}</div>
          <div style="font-size:0.75rem; color:#64748b; margin-top:0.15rem;">${tag.desc || ""}</div>
        </div>
        <div class="onboard-check">✓</div>
      </div>
    `;
  }).join("");

  document.getElementById("onboarding-goals-grid").innerHTML = SIGNAL_GOALS.map(g => {
    const selected = tempSelectedGoals.has(g.id);
    return `
      <div onclick="toggleTempGoal('${g.id}')" class="onboard-option ${selected ? "selected" : ""}">
        <div>
          <div style="font-size:0.85rem; font-weight:700; color:#0f172a;">${g.title}</div>
          <div style="font-size:0.75rem; color:#64748b; margin-top:0.15rem;">${g.desc}</div>
        </div>
        <div class="onboard-check">✓</div>
      </div>
    `;
  }).join("");

  const matched = repos.filter(r => (r.tags || []).some(t => tempSelectedTags.has(t))).length;
  document.getElementById("onboarding-match-preview").textContent =
    `${tempSelectedTags.size} channels · Matches ${matched} breakout repos`;
}

function toggleTempTag(id) {
  if (tempSelectedTags.has(id)) tempSelectedTags.delete(id);
  else tempSelectedTags.add(id);
  renderOnboardingOptions();
}

function toggleTempGoal(id) {
  if (tempSelectedGoals.has(id)) tempSelectedGoals.delete(id);
  else tempSelectedGoals.add(id);
  renderOnboardingOptions();
}

function saveOnboardingChoices() {
  const tags = tempSelectedTags.size > 0 ? Array.from(tempSelectedTags) : ["ai-llm", "data-spark"];
  const goals = tempSelectedGoals.size > 0 ? Array.from(tempSelectedGoals) : ["viral"];
  activeUser = completeUserOnboarding(tags, goals);
  activeChannelFilter = "ALL";
  document.getElementById("onboarding-modal")?.classList.add("hidden");
  renderSharedHorizontalNavbar();
  renderHorizontalTagStrip();
  if (CURRENT_PAGE !== "benchmarks") renderPageTable();
}

function skipOnboardingDefault() {
  activeUser = completeUserOnboarding(["ai-llm", "data-spark", "python"], ["viral"]);
  document.getElementById("onboarding-modal")?.classList.add("hidden");
  renderSharedHorizontalNavbar();
  renderHorizontalTagStrip();
  if (CURRENT_PAGE !== "benchmarks") renderPageTable();
}

// ============================================================================
// 3. FORECAST CHART RENDERER (SHARED BY MODAL & GLOBAL INSPECTOR)
// ============================================================================
function drawForecastLineChart(canvasId, existingInstance, repo) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (existingInstance) existingInstance.destroy();

  const labels = ["D-6", "D-5", "D-4", "D-3", "D-2", "D-1", "Today", "+1d", "+2d", "+3d", "+4d", "+5d", "+7d"];
  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Observed Stars",
          data: [...repo.hourly_history, null, null, null, null, null, null],
          borderColor: "#0f172a",
          backgroundColor: "rgba(15, 23, 42, 0.06)",
          borderWidth: 2.2,
          pointRadius: 2.5,
          fill: true,
          tension: 0.3
        },
        {
          label: "7d ML Forecast",
          data: [null, null, null, null, null, null, repo.hourly_history[6], ...repo.ml_forecast],
          borderColor: "#4f46e5",
          borderDash: [5, 4],
          borderWidth: 2.2,
          pointRadius: 2.5,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#475569", boxWidth: 12, font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "#f1f5f9" } },
        y: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "#f1f5f9" } }
      }
    }
  });
}

function openForecastModal(repoName) {
  const repo = globalDashboardData.emerging_repos.find(r => r.repo_name === repoName);
  if (!repo) return;

  document.getElementById("modal-repo-name").textContent = repo.repo_name;
  document.getElementById("modal-repo-desc").textContent = repo.description || "";
  document.getElementById("modal-lang").textContent = repo.language;
  document.getElementById("modal-cluster").innerHTML = getClusterBadge(repo.ml_cluster);
  document.getElementById("modal-stars").textContent = `+${repo.stars_24h.toLocaleString()}`;
  document.getElementById("modal-baseline").textContent = `${repo.baseline_avg_7d}/day`;
  document.getElementById("modal-forks").textContent = `+${repo.forks_24h}`;
  document.getElementById("modal-pushes").textContent = repo.pushes_24h;
  document.getElementById("modal-gh-link").href = `https://github.com/${repo.repo_name}`;

  document.getElementById("forecast-modal")?.classList.remove("hidden");
  modalForecastChart = drawForecastLineChart("modalForecastChart", modalForecastChart, repo);
}

function closeForecastModal() {
  document.getElementById("forecast-modal")?.classList.add("hidden");
}

function updateGlobalInlineInspector(repoName) {
  const repo = globalDashboardData.emerging_repos.find(r => r.repo_name === repoName);
  if (!repo) return;
  selectedGlobalRepo = repoName;

  document.querySelectorAll("#leaderboard-body tr").forEach(tr => {
    tr.classList.toggle("selected-row", tr.dataset.repo === repoName);
  });

  document.getElementById("insp-title").textContent = repo.repo_name;
  document.getElementById("insp-desc").textContent = repo.description || "";
  document.getElementById("insp-lang").textContent = repo.language;
  document.getElementById("insp-cluster").innerHTML = getClusterBadge(repo.ml_cluster);
  document.getElementById("insp-stars").textContent = `+${repo.stars_24h.toLocaleString()}`;
  document.getElementById("insp-baseline").textContent = `${repo.baseline_avg_7d}/day`;
  document.getElementById("insp-forks").textContent = `+${repo.forks_24h}`;
  document.getElementById("insp-pushes").textContent = repo.pushes_24h;
  document.getElementById("insp-gh-link").href = `https://github.com/${repo.repo_name}`;

  inlineForecastChart = drawForecastLineChart("inlineForecastChart", inlineForecastChart, repo);
}

// ============================================================================
// 4. PAGE-SPECIFIC TABLES & CHARTS
// ============================================================================
function mergeWatchlistIntoRepos(data) {
  const existing = new Set(data.emerging_repos.map(r => r.repo_name));
  (activeUser.watchlist || []).forEach((repoName, i) => {
    if (!existing.has(repoName)) {
      data.emerging_repos.push({
        rank: data.emerging_repos.length + 1,
        repo_name: repoName,
        description: "Synced from your public GitHub starred repositories.",
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

function renderForYouSpotlight() {
  const container = document.getElementById("als-cards");
  const section = document.getElementById("spotlight-section");
  if (!container || !section) return;

  const query = (document.getElementById("repo-search")?.value || "").trim();
  if (activeChannelFilter !== "ALL" || query !== "") {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  const userTags = activeUser.selected_tags || [];
  const tagLabels = Object.fromEntries(AVAILABLE_TAGS.map(t => [t.id, t.label]));

  const ranked = [...globalDashboardData.emerging_repos]
    .map(r => {
      const overlap = (r.tags || []).filter(t => userTags.includes(t)).length;
      return { ...r, affinity: overlap };
    })
    .filter(r => userTags.length === 0 || r.affinity > 0)
    .sort((a, b) => (b.affinity * 10 + b.momentum_z_score) - (a.affinity * 10 + a.momentum_z_score))
    .slice(0, 3);

  container.innerHTML = ranked.map((r, i) => {
    const matched = (r.tags || []).filter(t => userTags.includes(t)).map(t => tagLabels[t] || t);
    const matchPct = Math.min(99.4, 92.5 + r.affinity * 2.5 - i * 1.3).toFixed(1);
    return `
      <div onclick="openForecastModal('${r.repo_name}')" class="surface-card als-card">
        <div>
          <div class="als-card-top">
            <span class="als-repo-title">${r.repo_name}</span>
            <span class="als-match-pill">${matchPct}% Match</span>
          </div>
          <p class="als-desc">${r.description || r.language}</p>
        </div>
        <div class="als-card-foot">
          <span>${matched.length ? matched.join(" · ") : r.language}</span>
          <span class="als-star-gain font-mono">+${r.stars_24h.toLocaleString()} ★</span>
        </div>
      </div>
    `;
  }).join("");
}

function renderPageTable() {
  if (CURRENT_PAGE === "for-you") renderForYouSpotlight();

  const tbody = document.getElementById("leaderboard-body");
  if (!tbody) return;

  const query = (document.getElementById("repo-search")?.value || "").trim().toLowerCase();
  const sortKey = document.getElementById("repo-sort")?.value || "z_score";
  const userTags = activeUser.selected_tags || [];

  const filtered = globalDashboardData.emerging_repos.filter(r => {
    const matchesSearch =
      !query ||
      r.repo_name.toLowerCase().includes(query) ||
      r.language.toLowerCase().includes(query) ||
      (r.description || "").toLowerCase().includes(query);
    if (!matchesSearch) return false;

    if (CURRENT_PAGE === "watchlist") {
      return (activeUser.watchlist || []).includes(r.repo_name);
    }
    if (CURRENT_PAGE === "for-you") {
      if (activeChannelFilter !== "ALL") return (r.tags || []).includes(activeChannelFilter);
      return userTags.length === 0 || (r.tags || []).some(t => userTags.includes(t));
    }
    return true; // global page shows all
  }).sort((a, b) => {
    if (sortKey === "stars_24h") return b.stars_24h - a.stars_24h;
    if (sortKey === "forecast_7d") return b.predicted_stars_7d - a.predicted_stars_7d;
    return b.momentum_z_score - a.momentum_z_score;
  });

  document.getElementById("table-count").textContent = `${filtered.length} repositories`;
  const emptyState = document.getElementById("empty-state");
  tbody.innerHTML = "";

  if (filtered.length === 0) {
    emptyState?.classList.remove("hidden");
    return;
  }
  emptyState?.classList.add("hidden");

  const isGlobalSplit = CURRENT_PAGE === "global";

  filtered.forEach((repo, idx) => {
    const isStarred = (activeUser.watchlist || []).includes(repo.repo_name);
    const isAnomaly = repo.ml_cluster === "Bot Anomaly";
    const dotColor = LANG_COLORS[repo.language] || "#4f46e5";
    const [owner, name] = repo.repo_name.split("/");

    const tr = document.createElement("tr");
    tr.dataset.repo = repo.repo_name;
    if (isGlobalSplit && selectedGlobalRepo === repo.repo_name) tr.classList.add("selected-row");

    tr.onclick = () => {
      if (isGlobalSplit) updateGlobalInlineInspector(repo.repo_name);
      else openForecastModal(repo.repo_name);
    };

    tr.innerHTML = `
      <td class="font-mono tabular-nums" style="color:#64748b;">${idx + 1}</td>
      <td>
        <div>
          <span class="repo-owner">${owner} / </span>
          <span class="repo-name-link">${name || repo.repo_name}</span>
        </div>
        <div class="repo-subdesc">${repo.description || ""}</div>
        <div class="lang-tag">
          <span class="lang-dot" style="background:${dotColor}"></span>
          <span>${repo.language}</span>
        </div>
      </td>
      ${!isGlobalSplit ? `<td>${buildSparklineSVG(repo.hourly_history, isAnomaly)}</td>` : ""}
      <td class="text-right font-mono tabular-nums" style="font-weight:600;">+${repo.stars_24h.toLocaleString()}</td>
      <td class="text-right font-mono tabular-nums" style="font-weight:700; color:${isAnomaly ? "#dc2626" : "#059669"};">
        ${repo.momentum_z_score.toFixed(2)}σ
      </td>
      ${!isGlobalSplit ? `<td class="text-right font-mono tabular-nums" style="color:#4f46e5; font-weight:600;">+${repo.predicted_stars_7d.toLocaleString()}</td>` : ""}
      <td>${getClusterBadge(repo.ml_cluster)}</td>
      <td class="text-right">
        <button type="button" onclick="handleStarToggle(event, '${repo.repo_name}')"
          class="star-btn ${isStarred ? "starred" : ""}" title="Save to Watchlist">★</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (isGlobalSplit && filtered.length > 0 && !selectedGlobalRepo) {
    updateGlobalInlineInspector(filtered[0].repo_name);
  }
}

function handleStarToggle(event, repoName) {
  event.stopPropagation();
  activeUser = toggleWatchlistRepo(repoName);
  const badge = document.getElementById("nav-watch-count");
  if (badge) badge.textContent = activeUser.watchlist.length;
  renderPageTable();
}

function renderBenchmarksPage(data) {
  document.getElementById("kpi-events").textContent = data.kpis.total_events_processed;
  document.getElementById("kpi-latency").textContent = data.kpis.incremental_latency_min;
  document.getElementById("kpi-speedup").textContent = `${data.kpis.speedup_factor} faster vs. full batch scan`;
  document.getElementById("kpi-bots").textContent = data.kpis.bot_traffic_filtered_pct;
  document.getElementById("kpi-compression").textContent = data.kpis.parquet_compression_saved || "78.2%";
  document.getElementById("last-updated").textContent = `Last Batch: ${data.kpis.last_batch_hour}`;

  new Chart(document.getElementById("benchmarkChart"), {
    type: "bar",
    data: {
      labels: data.benchmarks.horizons,
      datasets: [
        {
          label: "Full JSON Batch Scan (min)",
          data: data.benchmarks.full_recompute_min,
          backgroundColor: "#cbd5e1",
          borderRadius: 6
        },
        {
          label: "Incremental Parquet Merge (min)",
          data: data.benchmarks.incremental_pipeline_min,
          backgroundColor: "#4f46e5",
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#334155" } } },
      scales: {
        x: { ticks: { color: "#475569" }, grid: { display: false } },
        y: { ticks: { color: "#64748b" }, grid: { color: "#f1f5f9" } }
      }
    }
  });

  new Chart(document.getElementById("eventDistChart"), {
    type: "doughnut",
    data: {
      labels: data.event_distribution.labels,
      datasets: [{
        data: data.event_distribution.shares,
        backgroundColor: ["#4f46e5", "#10b981", "#0ea5e9", "#f59e0b", "#94a3b8"],
        borderColor: "#ffffff",
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: { legend: { position: "right", labels: { color: "#334155", boxWidth: 12 } } }
    }
  });
}

// ============================================================================
// 5. INITIALIZE CURRENT PAGE
// ============================================================================
window.addEventListener("DOMContentLoaded", async () => {
  if (!activeUser) return;

  renderSharedHorizontalNavbar();
  injectSharedModals();

  globalDashboardData = await loadDashboardData(activeUser.username);
  mergeWatchlistIntoRepos(globalDashboardData);

  if (CURRENT_PAGE === "for-you") {
    renderHorizontalTagStrip();
  }

  if (CURRENT_PAGE === "benchmarks") {
    renderBenchmarksPage(globalDashboardData);
  } else {
    renderPageTable();
    document.getElementById("repo-search")?.addEventListener("input", renderPageTable);
    document.getElementById("repo-sort")?.addEventListener("change", renderPageTable);
  }

  if (!activeUser.onboarding_completed) {
    openOnboardingModal();
  }
});
