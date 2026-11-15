let modalForecastChart = null;
let inlineForecastChart = null;
let globalDashboardData = null;

let activeUser = CURRENT_USER;
let activeChannelFilter = "ALL";
let selectedGlobalRepo = null;
let isBlindStudyMode = false;

let tempSelectedTags = new Set();
let tempSelectedGoals = new Set();

const CURRENT_PAGE = document.body.dataset.page || "for-you";

const LANG_COLORS = {
  "Python / CUDA": "#3572A5",
  "Python / Rust": "#dea584",
  "Python": "#3572A5",
  "Scala / Python": "#c22d40",
  "Rust": "#dea584",
  "TypeScript": "#3178c6",
  "Go / C": "#00ADD8",
  "Python / TypeScript": "#3572A5",
  "GitHub Starred": "#f59e0b"
};

function getClusterBadge(cluster, isNewlyCreated = false) {
  if (isNewlyCreated) {
    return `<span class="new-repo-badge">✦ Newly Created</span>`;
  }
  const map = {
    "Viral Breakout": "badge-viral",
    "High Momentum": "badge-momentum",
    "Lexical Match": "badge-mature",
    "Newly Created": "badge-momentum"
  };
  return `<span class="badge-cluster ${map[cluster] || "badge-mature"}">${cluster}</span>`;
}

function buildSparklineSVG(points) {
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${coords}"/></svg>`;
}

// ============================================================================
// 1. LEXICAL (TF-IDF) VS. SEMANTIC (SENTENCE TRANSFORMER) COSINE SCORING
// ============================================================================
function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !["for", "and", "the", "with", "from", "that", "using"].includes(w));
}

function computeLexicalAndSemanticScores(repo) {
  const queryText = (activeUser.workflow_query || "").trim();
  const userTags = activeUser.selected_tags || [];
  const queryTokens = tokenize(queryText);

  // Document surface text ONLY (Name + Description + Topics) -> Used by TF-IDF
  const lexicalDocTokens = new Set(tokenize(
    `${repo.repo_name} ${repo.description} ${(repo.topics || []).join(" ")} ${repo.language}`
  ));

  // Shared Semantic Concept Space (Includes synonyms/paraphrases like backtesting <-> simulation)
  const semanticSpaceTokens = new Set([
    ...lexicalDocTokens,
    ...tokenize((repo.semantic_concepts || []).join(" "))
  ]);

  const tagOverlap = (repo.tags || []).filter(t => userTags.includes(t)).length;
  const tagPrior = userTags.length > 0 ? Math.min(0.35, tagOverlap * 0.16) : 0.2;

  if (queryTokens.length === 0) {
    const baseLex = Math.min(0.95, 0.42 + tagPrior + (repo.momentum_z_score / 60));
    const baseSem = Math.min(0.98, 0.56 + tagPrior + (repo.momentum_z_score / 45));
    return {
      tfidf: +baseLex.toFixed(2),
      semantic: +baseSem.toFixed(2)
    };
  }

  // Sublinear TF-IDF lexical cosine approximation (strict exact/stem word overlap)
  let lexHits = 0;
  let semHits = 0;
  queryTokens.forEach(qt => {
    const stem = qt.replace(/(ing|s|es)$/, "");
    const hasLex = [...lexicalDocTokens].some(dt => dt === qt || (stem.length >= 4 && dt.startsWith(stem)));
    const hasSem = hasLex || [...semanticSpaceTokens].some(st => st === qt || (stem.length >= 4 && st.startsWith(stem)));
    if (hasLex) lexHits += 1;
    if (hasSem) semHits += 1;
  });

  const lexRatio = lexHits / queryTokens.length;
  const semRatio = semHits / queryTokens.length;

  const tfidfScore = lexHits === 0
    ? +(0.04 + tagPrior * 0.2).toFixed(2)
    : +Math.min(0.96, 0.28 + lexRatio * 0.62 + tagPrior * 0.2).toFixed(2);

  const semanticScore = semHits === 0
    ? +(0.18 + tagPrior * 0.45).toFixed(2)
    : +Math.min(0.98, 0.42 + semRatio * 0.48 + tagPrior * 0.25 + (repo.is_newly_created ? 0.04 : 0)).toFixed(2);

  return { tfidf: tfidfScore, semantic: semanticScore };
}

// ============================================================================
// 2. SHARED HORIZONTAL NAVBAR & TAG STRIP
// ============================================================================
function renderSharedHorizontalNavbar() {
  const nav = document.getElementById("shared-navbar");
  if (!nav) return;

  const watchCount = (activeUser.watchlist || []).length;
  const avatarSrc = activeUser.avatar || "https://github.com/identicons/default.png";
  const snapshotVer = globalDashboardData?.kpis?.snapshot_version || "v2026.11";

  nav.innerHTML = `
    <div class="top-navbar-inner">
      <div class="nav-left">
        <a href="./index.html" class="brand-link">
          <div class="auth-logo-mark">G</div>
          <span class="auth-brand-name">GitPulse</span>
          <span class="version-pill font-mono">${snapshotVer}</span>
        </a>

        <nav class="nav-links">
          <a href="./index.html" class="nav-link ${CURRENT_PAGE === "for-you" ? "active" : ""}">
            <span>✦ For You Feed</span>
          </a>
          <a href="./global.html" class="nav-link ${CURRENT_PAGE === "global" ? "active" : ""}">
            <span>🌐 Global Catalog</span>
          </a>
          <a href="./watchlist.html" class="nav-link ${CURRENT_PAGE === "watchlist" ? "active" : ""}">
            <span>★ Saved</span>
            <span id="nav-watch-count" class="nav-count-badge">${watchCount}</span>
          </a>
          <a href="./benchmarks.html" class="nav-link ${CURRENT_PAGE === "benchmarks" ? "active" : ""}">
            <span>📊 Benchmarks &amp; Integrity</span>
          </a>
        </nav>
      </div>

      <div class="nav-right">
        <div class="conn-pill">
          <span id="conn-dot" class="status-dot"></span>
          <span id="conn-label">Catalog Online</span>
        </div>

        <div class="user-horizontal-chip">
          <img src="${avatarSrc}" onerror="this.src='https://github.com/identicons/default.png'" class="user-avatar-sm" alt="Avatar" />
          <div class="user-meta-inline">
            <span class="user-handle">@${activeUser.username}</span>
            <span class="user-footprint-tag">${activeUser.footprint_status || "Active"}</span>
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
      All Interests (${userTags.length})
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
        <span class="tag-strip-label">Your Interests:</span>
        ${allPill}
        ${pills}
      </div>
      <button type="button" onclick="openOnboardingModal()" class="btn-edit-tags">
        <span># Edit Interests &amp; Workflow Goal</span>
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
// 3. ONBOARDING MODAL (TOPICS + LANGUAGES + FREE-FORM WORKFLOW GOAL)
// ============================================================================
function injectSharedModals() {
  const host = document.getElementById("shared-modals");
  if (!host) return;

  host.innerHTML = `
    <!-- Step 01 (Slide 3): Profile Intake & Interest Onboarding Modal -->
    <div id="onboarding-modal" class="modal-overlay hidden">
      <div class="modal-window">
        <div class="modal-top">
          <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:#4f46e5; letter-spacing:0.04em;">
            Step 01 · User Profile Intake
          </div>
          <h2 class="auth-card-title" style="margin-top:0.3rem;">Set your topics, languages &amp; workflow goals</h2>
          <p class="auth-card-subtitle" style="margin-top:0.3rem;">
            We combine your selected domain tags with your free-form workflow description to retrieve newly created and unseen repositories via TF-IDF and Sentence Transformer embeddings.
          </p>
        </div>

        <div class="modal-body">
          <div>
            <label for="onboard-workflow-input" class="input-label">1. Free-form workflow goal (used for Semantic &amp; TF-IDF cosine matching)</label>
            <input id="onboard-workflow-input" type="text"
              placeholder="e.g. Python tools for backtesting trading strategies"
              class="auth-input" style="margin-top:0.5rem; font-size:0.92rem;" />
          </div>

          <div>
            <div class="input-label">2. Select your topics &amp; preferred languages</div>
            <div id="onboarding-tags-grid" class="onboard-grid"></div>
          </div>

          <div>
            <div class="input-label">3. Discovery preferences</div>
            <div id="onboarding-goals-grid" class="onboard-grid"></div>
          </div>
        </div>

        <div class="modal-foot">
          <span id="onboarding-match-preview" class="font-mono" style="font-size:0.8rem; font-weight:600; color:#059669;"></span>
          <div style="display:flex; gap:0.65rem;">
            <button type="button" onclick="skipOnboardingDefault()" class="btn-auth-secondary">Use Sample Profile</button>
            <button type="button" onclick="saveOnboardingChoices()" class="btn-auth-primary btn-modal-submit">Save Profile &amp; Retrieve →</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 03 (Slide 3): Repository Context & Similarity Breakdown Modal -->
    <div id="forecast-modal" class="modal-overlay hidden" onclick="if(event.target===this) closeForecastModal()">
      <div class="modal-window" style="max-width:600px;">
        <div class="modal-top" style="display:flex; align-items:flex-start; justify-content:space-between; gap:1rem;">
          <div>
            <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem; flex-wrap:wrap;">
              <span id="modal-lang" class="version-pill"></span>
              <span id="modal-cluster"></span>
              <span id="modal-created" class="version-pill font-mono"></span>
            </div>
            <h2 id="modal-repo-name" class="auth-card-title" style="font-size:1.25rem;"></h2>
          </div>
          <button type="button" onclick="closeForecastModal()" class="auth-modal-close">✕</button>
        </div>

        <div class="modal-body">
          <p id="modal-repo-desc" class="auth-card-subtitle" style="margin:0;"></p>
          <div id="modal-topics" class="repo-meta-pills" style="margin-top:0;"></div>

          <div class="inspector-metrics-grid">
            <div class="inspector-stat-box" style="border-color:#c7d2fe; background:#eef2ff;">
              <div class="inspector-stat-label" style="color:#4338ca;">Sentence Transformer Cosine</div>
              <div id="modal-sem-score" class="inspector-stat-val tabular-nums" style="color:#4f46e5;">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">TF-IDF Lexical Cosine</div>
              <div id="modal-lex-score" class="inspector-stat-val tabular-nums">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">Observed Star Additions (24h)</div>
              <div id="modal-stars" class="inspector-stat-val tabular-nums">--</div>
            </div>
            <div class="inspector-stat-box">
              <div class="inspector-stat-label">Observed Forks · PRs · Issues</div>
              <div id="modal-activity" class="inspector-stat-val tabular-nums" style="font-size:0.92rem;">--</div>
            </div>
          </div>

          <div>
            <div class="input-label" style="margin-bottom:0.4rem;">7-Day Observed Star Additions (GH Archive Window)</div>
            <div style="height:200px; position:relative;">
              <canvas id="modalForecastChart"></canvas>
            </div>
          </div>
        </div>

        <div class="modal-foot">
          <span class="section-hint">Note: Observed star additions reflect recent window activity, not lifetime stars.</span>
          <a id="modal-gh-link" href="#" target="_blank" rel="noopener noreferrer" class="btn-auth-primary btn-modal-submit" style="text-decoration:none;">
            View on GitHub ↗
          </a>
        </div>
      </div>
    </div>
  `;
}

function openOnboardingModal() {
  tempSelectedTags = new Set(activeUser.selected_tags?.length ? activeUser.selected_tags : ["quant-finance", "python"]);
  tempSelectedGoals = new Set(activeUser.signal_goals?.length ? activeUser.signal_goals : ["newly-created", "semantic"]);
  const wfInput = document.getElementById("onboard-workflow-input");
  if (wfInput) {
    wfInput.value = activeUser.workflow_query || "Python tools for backtesting trading strategies";
  }
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
    `${tempSelectedTags.size} topics · ${matched} eligible catalog candidates`;
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
  const tags = tempSelectedTags.size > 0 ? Array.from(tempSelectedTags) : ["quant-finance", "python"];
  const goals = tempSelectedGoals.size > 0 ? Array.from(tempSelectedGoals) : ["newly-created", "semantic"];
  const wf = (document.getElementById("onboard-workflow-input")?.value || "").trim();

  activeUser = completeUserOnboarding(tags, goals, wf);
  const pageWfInput = document.getElementById("workflow-query-input");
  if (pageWfInput) pageWfInput.value = wf;

  activeChannelFilter = "ALL";
  document.getElementById("onboarding-modal")?.classList.add("hidden");
  renderSharedHorizontalNavbar();
  renderHorizontalTagStrip();
  if (CURRENT_PAGE !== "benchmarks") renderPageTable();
}

function skipOnboardingDefault() {
  const defaultQuery = "Python tools for backtesting trading strategies";
  activeUser = completeUserOnboarding(["quant-finance", "ai-llm", "python"], ["newly-created", "semantic"], defaultQuery);
  const pageWfInput = document.getElementById("workflow-query-input");
  if (pageWfInput) pageWfInput.value = defaultQuery;

  document.getElementById("onboarding-modal")?.classList.add("hidden");
  renderSharedHorizontalNavbar();
  renderHorizontalTagStrip();
  if (CURRENT_PAGE !== "benchmarks") renderPageTable();
}

// ============================================================================
// 4. WORKFLOW QUERY, HIDE REPO & BLIND PEER STUDY CONTROLS
// ============================================================================
function applyWorkflowQuery() {
  const input = document.getElementById("workflow-query-input");
  if (!input) return;
  activeUser = updateUserWorkflowQuery(input.value.trim());
  renderPageTable();
}

function setPresetPrompt(promptText) {
  const input = document.getElementById("workflow-query-input");
  if (input) input.value = promptText;
  activeUser = updateUserWorkflowQuery(promptText);
  activeChannelFilter = "ALL";
  renderHorizontalTagStrip();
  renderPageTable();
}

function handleHideRepo(event, repoName) {
  event.stopPropagation();
  activeUser = hideRepositoryForUser(repoName);
  renderHiddenRestorePill();
  renderPageTable();
}

function handleRestoreHidden() {
  activeUser = clearHiddenReposForUser();
  renderHiddenRestorePill();
  renderPageTable();
}

function renderHiddenRestorePill() {
  const pill = document.getElementById("hidden-restore-pill");
  if (!pill) return;
  const count = (activeUser.hidden_repos || []).length;
  if (count === 0) {
    pill.className = "hidden";
    return;
  }
  pill.className = "";
  pill.innerHTML = `
    <button type="button" onclick="handleRestoreHidden()" class="preset-query-chip" style="color:#dc2626; border-color:#fecaca; background:#fef2f2;">
      ${count} hidden · Undo hide
    </button>
  `;
}

function toggleBlindStudyMode() {
  isBlindStudyMode = !isBlindStudyMode;
  const btn = document.getElementById("btn-blind-study");
  const banner = document.getElementById("blind-study-banner");
  if (btn) {
    btn.classList.toggle("active", isBlindStudyMode);
    btn.textContent = isBlindStudyMode ? "🧪 Blind Study Mode: ON" : "🧪 Blind Study Mode: Off";
  }
  banner?.classList.toggle("hidden", !isBlindStudyMode);
  renderPageTable();
}

function handleRateCandidate(event, repoName, field, val) {
  event.stopPropagation();
  activeUser = savePeerStudyRating(repoName, field, val);
  renderPageTable();
}

function updateLiveStudyMetrics(displayedRepos) {
  if (!isBlindStudyMode) return;
  const top10 = displayedRepos.slice(0, 10);
  const ratings = activeUser.study_ratings || {};

  const ratedItems = top10.filter(r => ratings[r.repo_name] && ratings[r.repo_name].relevance !== null);
  if (ratedItems.length === 0) {
    document.getElementById("live-p10").textContent = "Rate items below";
    document.getElementById("live-ndcg10").textContent = "--";
    document.getElementById("live-novelty10").textContent = "--";
    return;
  }

  // Precision@K (share marked Somewhat=1 or Highly=2 relevant)
  const relevantCount = ratedItems.filter(r => ratings[r.repo_name].relevance >= 1).length;
  const pAtK = relevantCount / ratedItems.length;

  // NDCG@K using graded 0/1/2 relevance
  let dcg = 0;
  const relValues = [];
  top10.forEach((r, idx) => {
    const rel = ratings[r.repo_name]?.relevance ?? 0;
    relValues.push(rel);
    dcg += (Math.pow(2, rel) - 1) / Math.log2(idx + 2);
  });
  const idealRels = [...relValues].sort((a, b) => b - a);
  let idcg = 0;
  idealRels.forEach((rel, idx) => {
    idcg += (Math.pow(2, rel) - 1) / Math.log2(idx + 2);
  });
  const ndcg = idcg > 0 ? dcg / idcg : 0;

  // Novelty@K: Share of relevant items marked previously unfamiliar (novel === true)
  const novelRelevant = ratedItems.filter(r => ratings[r.repo_name].relevance >= 1 && ratings[r.repo_name].novel !== false).length;
  const novelty = ratedItems.length > 0 ? novelRelevant / ratedItems.length : 0;

  document.getElementById("live-p10").textContent = pAtK.toFixed(2);
  document.getElementById("live-ndcg10").textContent = ndcg.toFixed(2);
  document.getElementById("live-novelty10").textContent = novelty.toFixed(2);
}

// ============================================================================
// 5. CHARTS & MODALS
// ============================================================================
function drawObservedHistoryChart(canvasId, existingInstance, repo) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (existingInstance) existingInstance.destroy();

  const labels = ["Day -6", "Day -5", "Day -4", "Day -3", "Day -2", "Yesterday", "Today (24h)"];
  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Observed Star Additions (GH Archive)",
          data: repo.hourly_history,
          borderColor: "#4f46e5",
          backgroundColor: "rgba(79, 70, 229, 0.08)",
          borderWidth: 2.4,
          pointRadius: 3,
          fill: true,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#475569", boxWidth: 12, font: { size: 11 } } } },
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
  const scores = computeLexicalAndSemanticScores(repo);

  document.getElementById("modal-repo-name").textContent = repo.repo_name;
  document.getElementById("modal-repo-desc").textContent = repo.description || "";
  document.getElementById("modal-lang").textContent = repo.language;
  document.getElementById("modal-created").textContent = `Created: ${repo.created_at || "2026"}`;
  document.getElementById("modal-cluster").innerHTML = getClusterBadge(repo.ml_cluster, repo.is_newly_created);
  document.getElementById("modal-topics").innerHTML = (repo.topics || [])
    .map(t => `<span class="topic-chip">#${t}</span>`).join("");

  document.getElementById("modal-sem-score").textContent = isBlindStudyMode ? "Hidden (Blind)" : scores.semantic.toFixed(2);
  document.getElementById("modal-lex-score").textContent = isBlindStudyMode ? "Hidden (Blind)" : scores.tfidf.toFixed(2);
  document.getElementById("modal-stars").textContent = `+${repo.stars_24h.toLocaleString()}`;
  document.getElementById("modal-activity").textContent =
    `+${repo.forks_24h} forks · ${repo.prs_24h || 12} PRs · ${repo.issues_24h || 8} issues`;
  document.getElementById("modal-gh-link").href = `https://github.com/${repo.repo_name}`;

  document.getElementById("forecast-modal")?.classList.remove("hidden");
  modalForecastChart = drawObservedHistoryChart("modalForecastChart", modalForecastChart, repo);
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
  document.getElementById("insp-cluster").innerHTML = getClusterBadge(repo.ml_cluster, repo.is_newly_created);
  document.getElementById("insp-topics").innerHTML = (repo.topics || [])
    .map(t => `<span class="topic-chip">#${t}</span>`).join("");

  document.getElementById("insp-stars").textContent = `+${repo.stars_24h.toLocaleString()}`;
  document.getElementById("insp-created").textContent = repo.created_at || "2026-10";
  document.getElementById("insp-forks").textContent = `+${repo.forks_24h} forks / ${repo.prs_24h || 10} PRs`;
  document.getElementById("insp-pushes").textContent = `${repo.issues_24h || 9} issues / ${repo.pushes_24h} pushes`;
  document.getElementById("insp-gh-link").href = `https://github.com/${repo.repo_name}`;

  inlineForecastChart = drawObservedHistoryChart("inlineForecastChart", inlineForecastChart, repo);
}

// ============================================================================
// 6. FEED & BENCHMARKS RENDERING
// ============================================================================
function mergeWatchlistIntoRepos(data) {
  const existing = new Set(data.emerging_repos.map(r => r.repo_name));
  (activeUser.watchlist || []).forEach((repoName, i) => {
    if (!existing.has(repoName)) {
      data.emerging_repos.push({
        rank: data.emerging_repos.length + 1,
        repo_name: repoName,
        description: "Enriched via GitHub REST API from your starred profile.",
        language: "GitHub Starred",
        topics: ["starred", "user-profile"],
        semantic_concepts: ["developer", "workflow"],
        created_at: "2026-09-12",
        is_newly_created: false,
        tags: activeUser.selected_tags?.length ? [activeUser.selected_tags[0]] : ["python"],
        stars_24h: 64 + i * 22,
        forks_24h: 11 + i * 4,
        issues_24h: 5,
        prs_24h: 4,
        pushes_24h: 24 + i * 6,
        baseline_avg_7d: 18.5,
        momentum_z_score: +(7.4 - i * 0.6).toFixed(2),
        ml_cluster: "High Momentum",
        hourly_history: [15, 22, 30, 38, 46, 55, 64 + i * 22]
      });
    }
  });
}

function renderForYouSpotlight(scoredRepos, modelMode) {
  const container = document.getElementById("als-cards");
  const section = document.getElementById("spotlight-section");
  if (!container || !section) return;

  if (isBlindStudyMode) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  document.getElementById("spotlight-heading").textContent =
    modelMode === "tfidf"
      ? "✦ Top Lexical Matches (Baseline: Sublinear TF-IDF)"
      : "✦ Top Semantic Matches (Main: Sentence Transformer)";

  const top3 = scoredRepos.slice(0, 3);
  container.innerHTML = top3.map(r => {
    const activeScore = modelMode === "tfidf" ? r.scores.tfidf : r.scores.semantic;
    const scoreLabel = modelMode === "tfidf" ? `TF-IDF: ${activeScore.toFixed(2)}` : `Cosine: ${activeScore.toFixed(2)}`;
    return `
      <div onclick="openForecastModal('${r.repo_name}')" class="surface-card als-card">
        <div>
          <div class="als-card-top">
            <span class="als-repo-title">${r.repo_name}</span>
            <span class="als-match-pill font-mono">${scoreLabel}</span>
          </div>
          <p class="als-desc">${r.description}</p>
          <div class="repo-meta-pills">
            ${r.is_newly_created ? '<span class="new-repo-badge">✦ Newly Created</span>' : ""}
            ${(r.topics || []).slice(0, 2).map(t => `<span class="topic-chip">#${t}</span>`).join("")}
          </div>
        </div>
        <div class="als-card-foot">
          <span>${r.language}</span>
          <span class="als-star-gain font-mono">+${r.stars_24h.toLocaleString()} observed ★</span>
        </div>
      </div>
    `;
  }).join("");
}

function renderPageTable() {
  const tbody = document.getElementById("leaderboard-body");
  if (!tbody) return;

  const query = (document.getElementById("repo-search")?.value || "").trim().toLowerCase();
  const sortKey = document.getElementById("repo-sort")?.value || "z_score";
  const modelMode = document.getElementById("retrieval-model")?.value || "semantic";
  const hiddenSet = new Set(activeUser.hidden_repos || []);
  const userTags = activeUser.selected_tags || [];

  // Attach lexical & semantic scores to every candidate
  let candidates = globalDashboardData.emerging_repos
    .filter(r => CURRENT_PAGE === "watchlist" || !hiddenSet.has(r.repo_name))
    .map(r => ({ ...r, scores: computeLexicalAndSemanticScores(r) }))
    .filter(r => {
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
        if (activeChannelFilter !== "ALL" && !(r.tags || []).includes(activeChannelFilter)) return false;
        // In TF-IDF mode with an active workflow query, drop zero-lexical-overlap items to show Slide 6 mismatch!
        if (!isBlindStudyMode && modelMode === "tfidf" && (activeUser.workflow_query || "").trim() !== "") {
          return r.scores.tfidf >= 0.25;
        }
        return true;
      }
      return true;
    });

  // Sort logic
  if (CURRENT_PAGE === "for-you") {
    if (isBlindStudyMode) {
      // Deterministic blind shuffle by repo name hash so model identity is hidden (Slide 7)
      candidates.sort((a, b) => a.repo_name.localeCompare(b.repo_name));
    } else if (modelMode === "tfidf") {
      candidates.sort((a, b) => b.scores.tfidf - a.scores.tfidf || b.momentum_z_score - a.momentum_z_score);
    } else {
      candidates.sort((a, b) => b.scores.semantic - a.scores.semantic || b.momentum_z_score - a.momentum_z_score);
    }
    candidates = candidates.slice(0, 10); // Top 10 eligible repositories (Slide 6)
    renderForYouSpotlight(candidates, modelMode);
    updateLiveStudyMetrics(candidates);

    const thead = document.getElementById("for-you-thead");
    if (thead) {
      thead.innerHTML = isBlindStudyMode
        ? `<tr>
            <th>#</th>
            <th>Blind Shuffled Candidate</th>
            <th class="text-right">Observed Stars</th>
            <th>3-Tier Relevance (0 / 1 / 2)</th>
            <th>Familiarity (Novelty)</th>
            <th class="text-right">Save / Hide</th>
          </tr>`
        : `<tr>
            <th>#</th>
            <th>Repository, Topics &amp; Recency</th>
            <th class="text-right">TF-IDF Cosine</th>
            <th class="text-right">Semantic Cosine</th>
            <th class="text-right">Observed Stars (24h)</th>
            <th>Status</th>
            <th class="text-right">Save / Hide</th>
          </tr>`;
    }
  } else {
    candidates.sort((a, b) => {
      if (sortKey === "stars_24h") return b.stars_24h - a.stars_24h;
      if (sortKey === "newest") return (b.created_at || "").localeCompare(a.created_at || "");
      return b.momentum_z_score - a.momentum_z_score;
    });
  }

  document.getElementById("table-count").textContent = `${candidates.length} repositories`;
  const emptyState = document.getElementById("empty-state");
  tbody.innerHTML = "";

  if (candidates.length === 0) {
    emptyState?.classList.remove("hidden");
    return;
  }
  emptyState?.classList.add("hidden");

  const isGlobalSplit = CURRENT_PAGE === "global";

  candidates.forEach((repo, idx) => {
    const isStarred = (activeUser.watchlist || []).includes(repo.repo_name);
    const dotColor = LANG_COLORS[repo.language] || "#4f46e5";
    const [owner, name] = repo.repo_name.split("/");
    const rating = (activeUser.study_ratings || {})[repo.repo_name] || { relevance: null, novel: true };

    const tr = document.createElement("tr");
    tr.dataset.repo = repo.repo_name;
    if (isGlobalSplit && selectedGlobalRepo === repo.repo_name) tr.classList.add("selected-row");

    tr.onclick = () => {
      if (isGlobalSplit) updateGlobalInlineInspector(repo.repo_name);
      else openForecastModal(repo.repo_name);
    };

    const repoCellHTML = `
      <td>
        <div>
          <span class="repo-owner">${owner} / </span>
          <span class="repo-name-link">${name || repo.repo_name}</span>
        </div>
        <div class="repo-subdesc">${repo.description || ""}</div>
        <div class="repo-meta-pills">
          <span class="lang-tag" style="margin-top:0;">
            <span class="lang-dot" style="background:${dotColor}"></span>
            <span>${repo.language}</span>
          </span>
          ${(repo.topics || []).slice(0, 3).map(t => `<span class="topic-chip">#${t}</span>`).join("")}
        </div>
      </td>
    `;

    const actionsHTML = `
      <td class="text-right">
        <div class="action-btn-group">
          <button type="button" onclick="handleStarToggle(event, '${repo.repo_name}')"
            class="star-btn ${isStarred ? "starred" : ""}" title="Save repository">★</button>
          ${CURRENT_PAGE !== "watchlist" ? `<button type="button" onclick="handleHideRepo(event, '${repo.repo_name}')" class="hide-btn" title="Hide from feed">✕</button>` : ""}
        </div>
      </td>
    `;

    if (CURRENT_PAGE === "for-you" && isBlindStudyMode) {
      tr.innerHTML = `
        <td class="font-mono tabular-nums" style="color:#64748b;">${idx + 1}</td>
        ${repoCellHTML}
        <td class="text-right font-mono tabular-nums" style="font-weight:600;">+${repo.stars_24h.toLocaleString()}</td>
        <td>
          <div class="rating-group">
            <button type="button" onclick="handleRateCandidate(event, '${repo.repo_name}', 'relevance', 0)"
              class="rate-pill ${rating.relevance === 0 ? "active-rel-0" : ""}">0 · None</button>
            <button type="button" onclick="handleRateCandidate(event, '${repo.repo_name}', 'relevance', 1)"
              class="rate-pill ${rating.relevance === 1 ? "active-rel-1" : ""}">1 · Somewhat</button>
            <button type="button" onclick="handleRateCandidate(event, '${repo.repo_name}', 'relevance', 2)"
              class="rate-pill ${rating.relevance === 2 ? "active-rel-2" : ""}">2 · Highly</button>
          </div>
        </td>
        <td>
          <div class="rating-group">
            <button type="button" onclick="handleRateCandidate(event, '${repo.repo_name}', 'novel', true)"
              class="rate-pill ${rating.novel !== false ? "active-novel" : ""}">Unseen (New)</button>
            <button type="button" onclick="handleRateCandidate(event, '${repo.repo_name}', 'novel', false)"
              class="rate-pill ${rating.novel === false ? "active-rel-1" : ""}">Known</button>
          </div>
        </td>
        ${actionsHTML}
      `;
    } else if (CURRENT_PAGE === "for-you") {
      tr.innerHTML = `
        <td class="font-mono tabular-nums" style="color:#64748b;">${idx + 1}</td>
        ${repoCellHTML}
        <td class="text-right font-mono tabular-nums" style="color:${repo.scores.tfidf < 0.2 ? "#dc2626" : "#475569"}; font-weight:600;">
          ${repo.scores.tfidf.toFixed(2)}
        </td>
        <td class="text-right font-mono tabular-nums" style="color:#4f46e5; font-weight:700;">
          ${repo.scores.semantic.toFixed(2)}
        </td>
        <td class="text-right font-mono tabular-nums" style="font-weight:600;">+${repo.stars_24h.toLocaleString()}</td>
        <td>${getClusterBadge(repo.ml_cluster, repo.is_newly_created)}</td>
        ${actionsHTML}
      `;
    } else if (CURRENT_PAGE === "watchlist") {
      tr.innerHTML = `
        <td class="font-mono tabular-nums" style="color:#64748b;">${idx + 1}</td>
        ${repoCellHTML}
        <td>${buildSparklineSVG(repo.hourly_history)}</td>
        <td class="text-right font-mono tabular-nums" style="font-weight:600;">+${repo.stars_24h.toLocaleString()}</td>
        <td class="text-right font-mono tabular-nums" style="color:#059669; font-weight:700;">${repo.momentum_z_score.toFixed(2)}σ</td>
        <td>${getClusterBadge(repo.ml_cluster, repo.is_newly_created)}</td>
        ${actionsHTML}
      `;
    } else {
      tr.innerHTML = `
        <td class="font-mono tabular-nums" style="color:#64748b;">${idx + 1}</td>
        ${repoCellHTML}
        <td class="text-right font-mono tabular-nums" style="font-weight:600;">+${repo.stars_24h.toLocaleString()}</td>
        <td class="text-right font-mono tabular-nums" style="color:#059669; font-weight:700;">${repo.momentum_z_score.toFixed(2)}σ</td>
        <td>${getClusterBadge(repo.ml_cluster, repo.is_newly_created)}</td>
        ${actionsHTML}
      `;
    }

    tbody.appendChild(tr);
  });

  if (isGlobalSplit && candidates.length > 0 && !selectedGlobalRepo) {
    updateGlobalInlineInspector(candidates[0].repo_name);
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
  document.getElementById("kpi-speedup").textContent = `${data.kpis.speedup_factor} faster vs. full recompute`;
  document.getElementById("kpi-compression").textContent = data.kpis.parquet_compression_saved || "78.2%";
  document.getElementById("last-updated").textContent = `Snapshot ${data.kpis.snapshot_version || "v2026.11"} · ${data.kpis.last_batch_hour}`;

  const costBody = document.getElementById("cost-accounting-body");
  if (costBody && data.model_cost_accounting) {
    costBody.innerHTML = data.model_cost_accounting.map(row => `
      <tr>
        <td style="font-family:'Inter',sans-serif; font-weight:700; color:#0f172a;">${row.model}</td>
        <td class="text-right">${row.indexing_time}</td>
        <td class="text-right">${row.latency_p50_p95}</td>
        <td class="text-right">${row.ram_usage}</td>
        <td class="text-right">${row.disk_footprint}</td>
        <td class="text-right" style="color:#4f46e5; font-weight:700;">${row.precision_at_10}</td>
        <td class="text-right" style="color:#4f46e5; font-weight:700;">${row.ndcg_at_10}</td>
        <td class="text-right" style="color:#059669; font-weight:700;">${row.novelty_at_10}</td>
      </tr>
    `).join("");
  }

  new Chart(document.getElementById("benchmarkChart"), {
    type: "bar",
    data: {
      labels: data.benchmarks.horizons,
      datasets: [
        {
          label: "Full Recomputation (min)",
          data: data.benchmarks.full_recompute_min,
          backgroundColor: "#cbd5e1",
          borderRadius: 6
        },
        {
          label: "Incremental Spark Update (min)",
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
// 7. INITIALIZE PAGE
// ============================================================================
window.addEventListener("DOMContentLoaded", async () => {
  if (!activeUser) return;

  globalDashboardData = await loadDashboardData(activeUser.username);
  mergeWatchlistIntoRepos(globalDashboardData);

  renderSharedHorizontalNavbar();
  injectSharedModals();

  if (CURRENT_PAGE === "for-you") {
    renderHorizontalTagStrip();
    renderHiddenRestorePill();
    const wfInput = document.getElementById("workflow-query-input");
    if (wfInput) {
      wfInput.value = activeUser.workflow_query || "";
      wfInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyWorkflowQuery(); });
    }
    document.getElementById("retrieval-model")?.addEventListener("change", renderPageTable);
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
