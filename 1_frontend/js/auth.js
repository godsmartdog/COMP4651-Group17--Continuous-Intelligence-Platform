const SESSION_KEY = "cip_active_user";
const CUSTOM_USERS_KEY = "cip_registered_users";

const DOMAIN_PRESETS = {
  AI_BIGDATA: {
    role: "AI & Big Data Engineer",
    avatar: "https://github.com/identicons/kcmau.png",
    preferred_langs: ["Python / CUDA", "Scala / Python", "Rust / Python"],
    watchlist: ["deepseek-ai/DeepSeek-MoE-V4", "apache/spark-lakehouse-agent"],
    events_quota: "2,910,400",
    footprint_status: "Synced via Spark Silver Parquet"
  },
  WEB_CLOUD: {
    role: "Full-Stack & Edge Developer",
    avatar: "https://github.com/identicons/alice.png",
    preferred_langs: ["TypeScript", "Rust / Python"],
    watchlist: ["vercel/next-edge-runtime", "pydantic/fastapi-rust-core"],
    events_quota: "1,540,200",
    footprint_status: "Synced via Spark Silver Parquet"
  },
  SEC_OPS: {
    role: "Security & Bot Anomaly Analyst",
    avatar: "https://github.com/identicons/auditor.png",
    preferred_langs: ["Shell", "Scala / Python"],
    watchlist: ["crypto-auto-mirror/bot-farm-repo"],
    events_quota: "369,900",
    footprint_status: "Synced via Spark Silver Parquet"
  }
};

function getPresetUsers() {
  return {
    kcmau: { username: "kcmau", password: "123", ...DOMAIN_PRESETS.AI_BIGDATA },
    alice: { username: "alice", password: "123", ...DOMAIN_PRESETS.WEB_CLOUD },
    auditor: { username: "auditor", password: "123", ...DOMAIN_PRESETS.SEC_OPS }
  };
}

function getAllUsers() {
  const custom = JSON.parse(localStorage.getItem(CUSTOM_USERS_KEY) || "{}");
  return { ...getPresetUsers(), ...custom };
}

function switchAuthTab(tab) {
  const isSignIn = tab === "signin";
  document.getElementById("signin-form").classList.toggle("hidden", !isSignIn);
  document.getElementById("github-auth-box").classList.toggle("hidden", !isSignIn);
  document.getElementById("register-form").classList.toggle("hidden", isSignIn);

  document.getElementById("tab-signin").className = isSignIn
    ? "w-1/2 pb-3 text-sm font-bold text-blue-400 border-b-2 border-blue-400"
    : "w-1/2 pb-3 text-sm font-bold text-slate-400 hover:text-white";
  document.getElementById("tab-register").className = !isSignIn
    ? "w-1/2 pb-3 text-sm font-bold text-emerald-400 border-b-2 border-emerald-400"
    : "w-1/2 pb-3 text-sm font-bold text-slate-400 hover:text-white";
  document.getElementById("auth-error").classList.add("hidden");
}

function loginSuccess(userObj) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(userObj));
  window.location.href = "./1_frontend/index.html";
}

function quickDemoLogin(username) {
  const users = getAllUsers();
  if (users[username]) {
    pushUserFootprintToBackend(users[username], []);
    loginSuccess(users[username]);
  }
}

function mapGitHubLangsToLakehouse(ghLanguages) {
  const mapped = new Set();
  ghLanguages.forEach(lang => {
    if (["Python", "Jupyter Notebook", "C++", "CUDA", "Scala"].includes(lang)) {
      mapped.add("Python / CUDA");
      mapped.add("Scala / Python");
    }
    if (["TypeScript", "JavaScript", "HTML", "CSS", "Vue"].includes(lang)) {
      mapped.add("TypeScript");
    }
    if (["Rust", "Go", "C"].includes(lang)) {
      mapped.add("Rust / Python");
    }
    if (["Shell", "Dockerfile", "Makefile"].includes(lang)) {
      mapped.add("Shell");
    }
  });
  return mapped.size > 0 ? Array.from(mapped) : ["Python / CUDA", "TypeScript"];
}

// Pushes signed-in user & live event footprint to FastAPI + PostgreSQL -> triggers Spark GH Archive scan
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
        preferred_langs: userObj.preferred_langs,
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

// Connects to GitHub API to pull real profile, languages, stars, and GH-Archive-compatible public events
async function buildUserFromRealGitHub(githubUsername) {
  const [profileRes, reposRes, starredRes, eventsRes] = await Promise.all([
    fetch(`https://api.github.com/users/${githubUsername}`),
    fetch(`https://api.github.com/users/${githubUsername}/repos?sort=updated&per_page=20`),
    fetch(`https://api.github.com/users/${githubUsername}/starred?per_page=10`),
    fetch(`https://api.github.com/users/${githubUsername}/events/public?per_page=30`)
  ]);

  if (!profileRes.ok) {
    throw new Error(`GitHub user '${githubUsername}' not found or API rate-limited.`);
  }

  const profile = await profileRes.json();
  const repos = reposRes.ok ? await reposRes.json() : [];
  const starred = starredRes.ok ? await starredRes.json() : [];
  const publicEvents = eventsRes.ok ? await eventsRes.json() : [];

  const rawLangs = repos.map(r => r.language).filter(Boolean);
  const preferredLangs = mapGitHubLangsToLakehouse(rawLangs);
  const uniqueRawLangs = [...new Set(rawLangs)].slice(0, 4);

  // Map any matching repos or preload top relevant repo into watchlist
  const realStarredNames = starred.slice(0, 4).map(s => s.full_name);

  const userObj = {
    username: profile.login,
    avatar: profile.avatar_url,
    role: `GitHub Connected (${profile.public_repos} Repos • ${uniqueRawLangs.join(", ") || "Open Source"})`,
    preferred_langs: preferredLangs,
    watchlist: realStarredNames.length > 0 ? realStarredNames : ["deepseek-ai/DeepSeek-MoE-V4"],
    events_quota: ((profile.public_repos + publicEvents.length + 10) * 52400).toLocaleString(),
    recent_event_count: publicEvents.length,
    footprint_status: `Captured ${publicEvents.length} Live Events + Queued GH Archive Scan`
  };

  const pushedToBackend = await pushUserFootprintToBackend(userObj, publicEvents);
  if (pushedToBackend) {
    userObj.footprint_status = `Synced ${publicEvents.length} Events → Postgres & Spark`;
  }
  return userObj;
}

async function signInWithGitHub() {
  const btnText = document.getElementById("gh-btn-text");
  const errBox = document.getElementById("auth-error");
  errBox.classList.add("hidden");

  const ghHandle = prompt("Enter your GitHub Username to sync your developer footprint:", "godsmartdog");
  if (!ghHandle) return;

  try {
    btnText.textContent = `Collecting @${ghHandle.trim()} footprint...`;
    const userObj = await buildUserFromRealGitHub(ghHandle.trim());
    loginSuccess(userObj);
  } catch (err) {
    btnText.textContent = "Continue with GitHub Account";
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  }
}

// Form Listeners on Root Home Page
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
      err.textContent = "Invalid credentials. Demo password is '123', or use Continue with GitHub!";
      err.classList.remove("hidden");
    }
  });

  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = document.getElementById("reg-username").value.trim().toLowerCase();
    const p = document.getElementById("reg-password").value;
    const domain = document.getElementById("reg-domain").value;

    const customUsers = JSON.parse(localStorage.getItem(CUSTOM_USERS_KEY) || "{}");
    const newUser = {
      username: u,
      password: p,
      ...DOMAIN_PRESETS[domain],
      avatar: `https://github.com/${u}.png`
    };
    customUsers[u] = newUser;
    localStorage.setItem(CUSTOM_USERS_KEY, JSON.stringify(customUsers));
    await pushUserFootprintToBackend(newUser, []);
    loginSuccess(newUser);
  });
}

// Dashboard Guard & Helpers (Used inside 1_frontend/index.html)
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

function toggleWatchlistRepo(repoName) {
  const user = requireAuth();
  if (!user) return null;
  const idx = user.watchlist.indexOf(repoName);
  if (idx >= 0) user.watchlist.splice(idx, 1);
  else user.watchlist.push(repoName);

  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  const customUsers = JSON.parse(localStorage.getItem(CUSTOM_USERS_KEY) || "{}");
  customUsers[user.username] = user;
  localStorage.setItem(CUSTOM_USERS_KEY, JSON.stringify(customUsers));
  return user;
}
