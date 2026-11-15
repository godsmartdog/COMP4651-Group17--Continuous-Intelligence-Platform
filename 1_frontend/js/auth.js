const SESSION_KEY = "cip_active_user_v4";
const CUSTOM_USERS_KEY = "cip_registered_users_v4";

const AVAILABLE_TAGS = [
  { id: "quant-finance", slug: "quant-finance", label: "Quant & Finance", desc: "Backtesting, trading simulation & risk engines", icon: "📈" },
  { id: "ai-llm", slug: "ai-and-llms", label: "AI & LLMs", desc: "Inference kernels, RAG & multi-agent workflows", icon: "✦" },
  { id: "data-spark", slug: "data-engineering", label: "Data & Spark", desc: "Lakehouses, Parquet, streaming & SQL catalogs", icon: "⚡" },
  { id: "python", slug: "python-core", label: "Python", desc: "Async APIs, scientific computing & tooling", icon: "🐍" },
  { id: "rust-systems", slug: "rust-systems", label: "Rust & Systems", desc: "Compilers, runtimes & zero-copy memory", icon: "⚙" },
  { id: "typescript-web", slug: "web-typescript", label: "TypeScript & Web", desc: "Edge runtimes, React & full-stack apps", icon: "◈" },
  { id: "cloud-go", slug: "cloud-native", label: "Cloud & Go", desc: "Kubernetes, eBPF, Docker & distributed ops", icon: "☁" },
  { id: "devtools", slug: "developer-tools", label: "DevTools", desc: "Package managers, linters & CLI workflows", icon: "⌘" }
];

const SIGNAL_GOALS = [
  { id: "newly-created", title: "Newly Created & Unseen", desc: "Prioritize fresh repositories (<30 days old) gaining early traction" },
  { id: "semantic", title: "Intent & Workflow Match", desc: "Match underlying engineering concepts even when wording differs" },
  { id: "velocity", title: "Active Contributor Momentum", desc: "Weight observed star additions, forks, and PR activity" },
  { id: "infra", title: "Production-Grade Reliability", desc: "Focus on well-documented libraries and system components" }
];

function getPresetUsers() {
  return {
    kcmau: {
      username: "kcmau",
      password: "123",
      role: "Quant & Data Engineer",
      avatar: "https://github.com/identicons/kcmau.png",
      selected_tags: ["quant-finance", "ai-llm", "data-spark", "python"],
      signal_goals: ["newly-created", "semantic"],
      workflow_query: "Python tools for backtesting trading strategies",
      watchlist: ["deepseek-ai/DeepSeek-MoE-V4"],
      hidden_repos: [],
      study_ratings: {},
      footprint_status: "Snapshot v2026.11 · Profile Active",
      onboarding_completed: true
    },
    alice: {
      username: "alice",
      password: "123",
      role: "Full-Stack & Systems Dev",
      avatar: "https://github.com/identicons/alice.png",
      selected_tags: ["typescript-web", "rust-systems", "devtools"],
      signal_goals: ["newly-created", "velocity"],
      workflow_query: "Fast edge server runtime and Rust package build tools",
      watchlist: ["vercel/next-edge-runtime"],
      hidden_repos: [],
      study_ratings: {},
      footprint_status: "Snapshot v2026.11 · Profile Active",
      onboarding_completed: true
    },
    auditor: {
      username: "auditor",
      password: "123",
      role: "Cloud Infrastructure Engineer",
      avatar: "https://github.com/identicons/auditor.png",
      selected_tags: ["cloud-go", "data-spark", "rust-systems"],
      signal_goals: ["infra"],
      workflow_query: "Distributed stream deduplication and Kubernetes network tracing",
      watchlist: ["apache/spark-lakehouse-agent"],
      hidden_repos: [],
      study_ratings: {},
      footprint_status: "Snapshot v2026.11 · Profile Active",
      onboarding_completed: true
    }
  };
}

function getAllUsers() {
  const custom = JSON.parse(localStorage.getItem(CUSTOM_USERS_KEY) || "{}");
  return { ...getPresetUsers(), ...custom };
}

function saveUserRecord(userObj) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(userObj));
  const custom = JSON.parse(localStorage.getItem(CUSTOM_USERS_KEY) || "{}");
  custom[userObj.username.toLowerCase()] = userObj;
  localStorage.setItem(CUSTOM_USERS_KEY, JSON.stringify(custom));
}

let isRegisterMode = false;
function toggleAuthMode() {
  isRegisterMode = !isRegisterMode;
  document.getElementById("signin-form").classList.toggle("hidden", isRegisterMode);
  document.getElementById("github-auth-box").classList.toggle("hidden", isRegisterMode);
  document.getElementById("register-form").classList.toggle("hidden", !isRegisterMode);

  document.getElementById("auth-heading").textContent = isRegisterMode
    ? "Create your GitPulse account"
    : "Sign in to GitPulse";
  document.getElementById("auth-subheading").textContent = isRegisterMode
    ? "Submit your topics, preferred languages, and free-form workflow goals"
    : "Connect your GitHub handle or sign in to inspect your personalized catalog feed.";
  document.getElementById("auth-switch-prompt").textContent = isRegisterMode
    ? "Already have an account?"
    : "New to GitPulse?";
  document.getElementById("auth-switch-btn").textContent = isRegisterMode
    ? "Sign in"
    : "Create an account";
  document.getElementById("auth-error").classList.add("hidden");
}

function loginSuccess(userObj) {
  saveUserRecord(userObj);
  window.location.href = "./1_frontend/index.html";
}

function quickDemoLogin(username) {
  const users = getAllUsers();
  if (users[username]) loginSuccess(users[username]);
}

function quickNewUserDemo() {
  const demoId = "peer_" + Math.floor(100 + Math.random() * 899);
  loginSuccess({
    username: demoId,
    password: "123",
    role: "Peer Study Participant",
    avatar: `https://github.com/identicons/${demoId}.png`,
    selected_tags: [],
    signal_goals: ["newly-created", "semantic"],
    workflow_query: "",
    watchlist: [],
    hidden_repos: [],
    study_ratings: {},
    footprint_status: "Profile Intake · Set Interests",
    onboarding_completed: false
  });
}

function openGitHubModal() {
  document.getElementById("gh-modal")?.classList.remove("hidden");
  document.getElementById("gh-username-input")?.focus();
}

function closeGitHubModal() {
  document.getElementById("gh-modal")?.classList.add("hidden");
}

function inferTagsFromGitHubLangs(ghLanguages) {
  const tags = new Set();
  ghLanguages.forEach(lang => {
    if (["Python", "Jupyter Notebook", "CUDA"].includes(lang)) {
      tags.add("python");
      tags.add("ai-llm");
    }
    if (["Scala", "Java", "SQL"].includes(lang)) tags.add("data-spark");
    if (["TypeScript", "JavaScript", "HTML", "CSS", "Vue"].includes(lang)) tags.add("typescript-web");
    if (["Rust", "C", "C++"].includes(lang)) tags.add("rust-systems");
    if (["Go", "Shell", "Dockerfile"].includes(lang)) tags.add("cloud-go");
  });
  return Array.from(tags);
}

async function buildUserFromRealGitHub(githubUsername) {
  const existing = getAllUsers()[githubUsername.toLowerCase()];
  if (existing && existing.onboarding_completed) return existing;

  const [profileRes, reposRes, starredRes] = await Promise.all([
    fetch(`https://api.github.com/users/${githubUsername}`),
    fetch(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=15`),
    fetch(`https://api.github.com/users/${githubUsername}/starred?per_page=8`)
  ]);

  if (!profileRes.ok) {
    throw new Error(`GitHub user '${githubUsername}' not found or API rate-limited.`);
  }

  const profile = await profileRes.json();
  const repos = reposRes.ok ? await reposRes.json() : [];
  const starred = starredRes.ok ? await starredRes.json() : [];

  const rawLangs = repos.map(r => r.language).filter(Boolean);
  const suggestedTags = inferTagsFromGitHubLangs(rawLangs);

  return {
    username: profile.login,
    avatar: profile.avatar_url,
    role: `${profile.public_repos} public repos`,
    selected_tags: suggestedTags,
    signal_goals: ["newly-created", "semantic"],
    workflow_query: "",
    watchlist: starred.slice(0, 4).map(s => s.full_name),
    hidden_repos: [],
    study_ratings: {},
    footprint_status: "GitHub Enriched · Set Workflow Goal",
    onboarding_completed: false
  };
}

if (document.getElementById("signin-form")) {
  document.getElementById("signin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim().toLowerCase();
    const p = document.getElementById("login-password").value;
    const users = getAllUsers();

    if (users[u] && users[u].password === p) {
      loginSuccess(users[u]);
    } else {
      const err = document.getElementById("auth-error");
      err.textContent = "Incorrect username or password (demo password: 123).";
      err.classList.remove("hidden");
    }
  });

  document.getElementById("register-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const u = document.getElementById("reg-username").value.trim().toLowerCase();
    const p = document.getElementById("reg-password").value;
    loginSuccess({
      username: u,
      password: p,
      role: "Developer",
      avatar: `https://github.com/${u}.png`,
      selected_tags: [],
      signal_goals: ["newly-created", "semantic"],
      workflow_query: "",
      watchlist: [],
      hidden_repos: [],
      study_ratings: {},
      footprint_status: "Profile Intake · Set Interests",
      onboarding_completed: false
    });
  });

  document.getElementById("gh-connect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ghHandle = document.getElementById("gh-username-input").value.trim();
    const btn = document.getElementById("gh-submit-btn");
    const err = document.getElementById("auth-error");
    if (!ghHandle) return;

    try {
      btn.textContent = "Connecting...";
      btn.disabled = true;
      const userObj = await buildUserFromRealGitHub(ghHandle);
      loginSuccess(userObj);
    } catch (error) {
      closeGitHubModal();
      btn.textContent = "Connect GitHub";
      btn.disabled = false;
      err.textContent = error.message;
      err.classList.remove("hidden");
    }
  });
}

function requireAuth() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    window.location.replace("../index.html");
    return null;
  }
  return JSON.parse(raw);
}

function signOut() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = "../index.html";
}

function completeUserOnboarding(selectedTags, selectedGoals, workflowQuery = "") {
  const user = requireAuth();
  if (!user) return null;

  user.selected_tags = selectedTags;
  user.signal_goals = selectedGoals;
  user.workflow_query = workflowQuery;
  user.onboarding_completed = true;
  user.footprint_status = "Catalog Snapshot v2026.11";

  saveUserRecord(user);
  return user;
}

function updateUserWorkflowQuery(queryText) {
  const user = requireAuth();
  if (!user) return null;
  user.workflow_query = queryText;
  saveUserRecord(user);
  return user;
}

function toggleWatchlistRepo(repoName) {
  const user = requireAuth();
  if (!user) return null;
  user.watchlist = user.watchlist || [];
  const idx = user.watchlist.indexOf(repoName);
  if (idx >= 0) user.watchlist.splice(idx, 1);
  else user.watchlist.push(repoName);
  saveUserRecord(user);
  return user;
}

function hideRepositoryForUser(repoName) {
  const user = requireAuth();
  if (!user) return null;
  user.hidden_repos = user.hidden_repos || [];
  if (!user.hidden_repos.includes(repoName)) user.hidden_repos.push(repoName);
  saveUserRecord(user);
  return user;
}

function clearHiddenReposForUser() {
  const user = requireAuth();
  if (!user) return null;
  user.hidden_repos = [];
  saveUserRecord(user);
  return user;
}

function savePeerStudyRating(repoName, field, value) {
  const user = requireAuth();
  if (!user) return null;
  user.study_ratings = user.study_ratings || {};
  user.study_ratings[repoName] = user.study_ratings[repoName] || { relevance: null, novel: true };
  user.study_ratings[repoName][field] = value;
  saveUserRecord(user);
  return user;
}
