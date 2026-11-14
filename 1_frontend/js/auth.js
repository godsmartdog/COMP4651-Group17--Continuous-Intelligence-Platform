const SESSION_KEY = "cip_active_user_v2";
const CUSTOM_USERS_KEY = "cip_registered_users_v2";

// Industry-standard tag taxonomy (shared between Onboarding Modal & Repo Filtering)
const AVAILABLE_TAGS = [
  { id: "ai-llm", label: "AI & LLMs", icon: "✦" },
  { id: "data-spark", label: "Data & Spark", icon: "⚡" },
  { id: "python", label: "Python", icon: "🐍" },
  { id: "rust-systems", label: "Rust & Systems", icon: "⚙" },
  { id: "typescript-web", label: "TypeScript & Web", icon: "◈" },
  { id: "cloud-go", label: "Cloud-Native & Go", icon: "☁" },
  { id: "security-bots", label: "SecOps & Anomaly", icon: "🛡" },
  { id: "devtools", label: "Developer Tools", icon: "⌘" }
];

const SIGNAL_GOALS = [
  { id: "viral", title: "Early Viral Breakouts", desc: "Spot <5k star repos experiencing >10x Z-score surges" },
  { id: "velocity", title: "High Contributor Velocity", desc: "Prioritize active PR merges and multi-actor commits" },
  { id: "infra", title: "Production Infrastructure", desc: "Focus on lakehouse, cloud, and runtime engines" },
  { id: "anomaly", title: "Bot & Spam Detection", desc: "Surface suspicious push-to-star anomalies" }
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
      footprint_status: "Warm · Spark Silver Parquet",
      onboarding_completed: true
    },
    alice: {
      username: "alice",
      password: "123",
      role: "Frontend & Edge Architect",
      avatar: "https://github.com/identicons/alice.png",
      selected_tags: ["typescript-web", "rust-systems", "devtools"],
      signal_goals: ["viral", "velocity"],
      watchlist: ["vercel/next-edge-runtime", "pydantic/fastapi-rust-core"],
      events_quota: "1,540,200",
      footprint_status: "Warm · Spark Silver Parquet",
      onboarding_completed: true
    },
    auditor: {
      username: "auditor",
      password: "123",
      role: "Platform Integrity Analyst",
      avatar: "https://github.com/identicons/auditor.png",
      selected_tags: ["security-bots", "cloud-go", "data-spark"],
      signal_goals: ["anomaly"],
      watchlist: ["crypto-auto-mirror/bot-farm-repo"],
      events_quota: "369,900",
      footprint_status: "Warm · Spark Silver Parquet",
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

function switchAuthTab(tab) {
  const isSignIn = tab === "signin";
  document.getElementById("signin-form").classList.toggle("hidden", !isSignIn);
  document.getElementById("github-auth-box").classList.toggle("hidden", !isSignIn);
  document.getElementById("register-form").classList.toggle("hidden", isSignIn);

  document.getElementById("tab-signin").className = isSignIn
    ? "py-1.5 rounded-md bg-[#181b22] text-zinc-100 shadow-sm transition"
    : "py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 transition";
  document.getElementById("tab-register").className = !isSignIn
    ? "py-1.5 rounded-md bg-[#181b22] text-zinc-100 shadow-sm transition"
    : "py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 transition";
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

// 1-click tester to demo the Discord-style onboarding modal anytime
function quickNewUserDemo() {
  const demoId = "new_dev_" + Math.floor(100 + Math.random() * 899);
  const freshUser = {
    username: demoId,
    password: "123",
    role: "New Member (Cold-Start)",
    avatar: `https://github.com/identicons/${demoId}.png`,
    selected_tags: [],
    signal_goals: ["viral"],
    watchlist: [],
    events_quota: "0 (Awaiting Tags)",
    footprint_status: "Cold-Start · No Footprint Yet",
    onboarding_completed: false
  };
  loginSuccess(freshUser);
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
  if (existing && existing.onboarding_completed) {
    return existing;
  }

  const [profileRes, reposRes, starredRes, eventsRes] = await Promise.all([
    fetch(`https://api.github.com/users/${githubUsername}`),
    fetch(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=15`),
    fetch(`https://api.github.com/users/${githubUsername}/starred?per_page=8`),
    fetch(`https://api.github.com/users/${githubUsername}/events/public?per_page=25`)
  ]);

  if (!profileRes.ok) {
    throw new Error(`GitHub account '${githubUsername}' not found or API rate-limited.`);
  }

  const profile = await profileRes.json();
  const repos = reposRes.ok ? await reposRes.json() : [];
  const starred = starredRes.ok ? await starredRes.json() : [];
  const publicEvents = eventsRes.ok ? await eventsRes.json() : [];

  const rawLangs = repos.map(r => r.language).filter(Boolean);
  const suggestedTags = inferTagsFromGitHubLangs(rawLangs);
  const starredNames = starred.slice(0, 4).map(s => s.full_name);

  // First-time GitHub joiner: pre-highlight suggested tags, and open Discord-style onboarding
  // because our backend GH Archive pipeline hasn't tracked their historical footprint yet
  const userObj = {
    username: profile.login,
    avatar: profile.avatar_url,
    role: `GitHub · ${profile.public_repos} Public Repos`,
    selected_tags: suggestedTags,
    signal_goals: ["viral"],
    watchlist: starredNames,
    events_quota: ((profile.public_repos + publicEvents.length + 8) * 48200).toLocaleString(),
    footprint_status: `Cold-Start · Queued GH Archive Scan (${publicEvents.length} live events)`,
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
      err.textContent = "Invalid username or password. Demo password is '123'.";
      err.classList.remove("hidden");
    }
  });

  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = document.getElementById("reg-username").value.trim().toLowerCase();
    const p = document.getElementById("reg-password").value;

    const newUser = {
      username: u,
      password: p,
      role: "Developer Member",
      avatar: `https://github.com/${u}.png`,
      selected_tags: [],
      signal_goals: ["viral"],
      watchlist: [],
      events_quota: "0 (Select tags)",
      footprint_status: "Cold-Start · Awaiting Tag Selection",
      onboarding_completed: false
    };
    loginSuccess(newUser);
  });

  document.getElementById("gh-connect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ghHandle = document.getElementById("gh-username-input").value.trim();
    const btn = document.getElementById("gh-submit-btn");
    const err = document.getElementById("auth-error");
    if (!ghHandle) return;

    try {
      btn.textContent = "Syncing GitHub...";
      btn.disabled = true;
      const userObj = await buildUserFromRealGitHub(ghHandle);
      loginSuccess(userObj);
    } catch (error) {
      closeGitHubModal();
      btn.textContent = "Sync & Continue";
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
  user.footprint_status = "Cold-Start Tags Active · Queued Spark Scan";

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
