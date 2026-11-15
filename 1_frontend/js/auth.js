const SESSION_KEY = "cip_active_user_v3";
const CUSTOM_USERS_KEY = "cip_registered_users_v3";

const AVAILABLE_TAGS = [
  { id: "ai-llm", slug: "ai-and-llms", label: "AI & LLMs", desc: "Inference engines, agents & CUDA kernels", icon: "✦" },
  { id: "data-spark", slug: "data-engineering", label: "Data & Spark", desc: "Lakehouses, Parquet, streaming & SQL", icon: "⚡" },
  { id: "python", slug: "python-core", label: "Python", desc: "Async frameworks, ML tooling & bindings", icon: "🐍" },
  { id: "rust-systems", slug: "rust-systems", label: "Rust & Systems", desc: "Compilers, runtimes & low-level speed", icon: "⚙" },
  { id: "typescript-web", slug: "web-typescript", label: "TypeScript & Web", desc: "Edge runtimes, React & full-stack apps", icon: "◈" },
  { id: "cloud-go", slug: "cloud-native", label: "Cloud & Go", desc: "Kubernetes, eBPF, Docker & infra", icon: "☁" },
  { id: "security-bots", slug: "secops-anomalies", label: "SecOps & Bots", desc: "Spam detection & supply-chain security", icon: "🛡" },
  { id: "devtools", slug: "developer-tools", label: "DevTools", desc: "Package managers, CLIs & workflows", icon: "⌘" }
];

const SIGNAL_GOALS = [
  { id: "viral", title: "Early Viral Breakouts", desc: "Surface <5k star repos with >10σ Z-score surges" },
  { id: "velocity", title: "High Contributor Velocity", desc: "Weight human PR merges and multi-actor commits" },
  { id: "infra", title: "Production Infrastructure", desc: "Prioritize storage, compute & cloud engines" },
  { id: "anomaly", title: "Bot & Spam Flagging", desc: "Highlight suspicious push-to-star anomalies" }
];

function getPresetUsers() {
  return {
    kcmau: {
      username: "kcmau",
      password: "123",
      role: "Data & ML Engineer",
      avatar: "https://github.com/identicons/kcmau.png",
      selected_tags: ["ai-llm", "data-spark", "python"],
      signal_goals: ["viral", "infra"],
      watchlist: ["deepseek-ai/DeepSeek-MoE-V4", "apache/spark-lakehouse-agent"],
      events_quota: "2,910,400",
      footprint_status: "Spark Silver Synced",
      onboarding_completed: true
    },
    alice: {
      username: "alice",
      password: "123",
      role: "Full-Stack & Edge Dev",
      avatar: "https://github.com/identicons/alice.png",
      selected_tags: ["typescript-web", "rust-systems", "devtools"],
      signal_goals: ["viral", "velocity"],
      watchlist: ["vercel/next-edge-runtime", "pydantic/fastapi-rust-core"],
      events_quota: "1,540,200",
      footprint_status: "Spark Silver Synced",
      onboarding_completed: true
    },
    auditor: {
      username: "auditor",
      password: "123",
      role: "Platform SecOps",
      avatar: "https://github.com/identicons/auditor.png",
      selected_tags: ["security-bots", "cloud-go", "data-spark"],
      signal_goals: ["anomaly"],
      watchlist: ["crypto-auto-mirror/bot-farm-repo"],
      events_quota: "369,900",
      footprint_status: "Spark Silver Synced",
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
    ? "Pick your channels right after sign-up to solve Day-1 cold start"
    : "Open-source breakout intelligence powered by Apache Spark";
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
  if (users[username]) {
    pushUserFootprintToBackend(users[username], []);
    loginSuccess(users[username]);
  }
}

function quickNewUserDemo() {
  const demoId = "guest_" + Math.floor(100 + Math.random() * 899);
  loginSuccess({
    username: demoId,
    password: "123",
    role: "New Member",
    avatar: `https://github.com/identicons/${demoId}.png`,
    selected_tags: [],
    signal_goals: ["viral"],
    watchlist: [],
    events_quota: "0",
    footprint_status: "Cold-Start · Pick Channels",
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

async function pushUserFootprintToBackend(userObj, recentPublicEvents = []) {
  const isGitHubPages = window.location.hostname.includes("github.io");
  const backendUrl = isGitHubPages ? "" : "http://localhost:8000/api/users/sync-footprint";
  if (!backendUrl) return false;

  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: userObj.username,
        avatar_url: userObj.avatar,
        selected_tags: userObj.selected_tags,
        signal_goals: userObj.signal_goals,
        watchlist: userObj.watchlist,
        recent_events: recentPublicEvents
      }),
      signal: AbortSignal.timeout(1200)
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function buildUserFromRealGitHub(githubUsername) {
  const existing = getAllUsers()[githubUsername.toLowerCase()];
  if (existing && existing.onboarding_completed) return existing;

  const [profileRes, reposRes, starredRes, eventsRes] = await Promise.all([
    fetch(`https://api.github.com/users/${githubUsername}`),
    fetch(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=15`),
    fetch(`https://api.github.com/users/${githubUsername}/starred?per_page=8`),
    fetch(`https://api.github.com/users/${githubUsername}/events/public?per_page=25`)
  ]);

  if (!profileRes.ok) {
    throw new Error(`GitHub user '${githubUsername}' not found or rate-limited.`);
  }

  const profile = await profileRes.json();
  const repos = reposRes.ok ? await reposRes.json() : [];
  const starred = starredRes.ok ? await starredRes.json() : [];
  const publicEvents = eventsRes.ok ? await eventsRes.json() : [];

  const rawLangs = repos.map(r => r.language).filter(Boolean);
  const suggestedTags = inferTagsFromGitHubLangs(rawLangs);

  const userObj = {
    username: profile.login,
    avatar: profile.avatar_url,
    role: `${profile.public_repos} public repos`,
    selected_tags: suggestedTags,
    signal_goals: ["viral"],
    watchlist: starred.slice(0, 4).map(s => s.full_name),
    events_quota: ((profile.public_repos + publicEvents.length + 8) * 48200).toLocaleString(),
    footprint_status: `Queued GH Archive (${publicEvents.length} live events)`,
    onboarding_completed: false
  };

  await pushUserFootprintToBackend(userObj, publicEvents);
  return userObj;
}

if (document.getElementById("signin-form")) {
  document.getElementById("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim().toLowerCase();
    const p = document.getElementById("login-password").value;
    const users = getAllUsers();

    if (users[u] && users[u].password === p) {
      await pushUserFootprintToBackend(users[u], []);
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
      signal_goals: ["viral"],
      watchlist: [],
      events_quota: "0",
      footprint_status: "Cold-Start · Pick Channels",
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
      btn.textContent = "Connect";
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

function completeUserOnboarding(selectedTags, selectedGoals) {
  const user = requireAuth();
  if (!user) return null;

  user.selected_tags = selectedTags;
  user.signal_goals = selectedGoals;
  user.onboarding_completed = true;
  user.events_quota = (selectedTags.length * 645200).toLocaleString();
  user.footprint_status = "Channels Active · Spark Queued";

  saveUserRecord(user);
  pushUserFootprintToBackend(user, []);
  return user;
}

function toggleWatchlistRepo(repoName) {
  const user = requireAuth();
  if (!user) return null;
  const idx = user.watchlist.indexOf(repoName);
  if (idx >= 0) user.watchlist.splice(idx, 1);
  else user.watchlist.push(repoName);
  saveUserRecord(user);
  return user;
}
