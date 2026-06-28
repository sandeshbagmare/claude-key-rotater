/**
 * Claude CLI API Key Rotation Proxy v2.0
 * 
 * Features:
 *  - Weighted round-robin, least-used, random rotation strategies
 *  - Web dashboard on port 4892 for real-time monitoring & management
 *  - REST API for key management (add/remove/enable/disable/weight/budget)
 *  - Per-key budget tracking with auto-disable
 *  - Cost tracking from API response headers (input/output tokens)
 *  - Request logging with live feed
 *  - Hot-reload config without downtime
 *  - CLI integration via /api/* endpoints
 *
 * Usage:
 *   node proxy.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── File Paths ──────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, '.rotation-state.json');
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');

// ─── Load Config ─────────────────────────────────────────────────────────────

let config = loadConfig();

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[FATAL] Cannot read config.json:', err.message);
    process.exit(1);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[WARN] Could not save config:', err.message);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

const startTime = Date.now();

let state = {
  currentIndex: 0,
  keyStats: [],
};

// Request log ring buffer (last 200 entries)
const MAX_LOG_ENTRIES = 200;
let requestLog = [];

function initKeyStats() {
  state.keyStats = config.keys.map((k, i) => {
    // Preserve existing stats if available
    const existing = state.keyStats[i];
    if (existing && existing.label === k.label) {
      return existing;
    }
    return {
      label: k.label,
      totalRequests: 0,
      totalErrors: 0,
      lastUsed: null,
      rateLimitedUntil: null,
      rateLimitedReason: null,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      budgetUsed: 0,
      budgetResetAt: null,
      errorLog: [],          // per-key error ring buffer
      balance: null,         // last fetched balance value (number) or null
      balanceRaw: null,      // raw balance string for display
      balanceCheckedAt: null,
      balanceError: null,    // last balance-check error message
    };
  });
}

// Max error-log entries kept per key
const MAX_KEY_ERRORS = 40;

function newKeyStats(label) {
  return {
    label,
    totalRequests: 0,
    totalErrors: 0,
    lastUsed: null,
    rateLimitedUntil: null,
    rateLimitedReason: null,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    budgetUsed: 0,
    budgetResetAt: null,
    errorLog: [],
    balance: null,
    balanceRaw: null,
    balanceCheckedAt: null,
    balanceError: null,
  };
}

function logKeyError(keyIndex, statusCode, message) {
  const stats = state.keyStats[keyIndex];
  if (!stats) return;
  if (!Array.isArray(stats.errorLog)) stats.errorLog = [];
  stats.errorLog.push({
    timestamp: new Date().toISOString(),
    statusCode,
    message: String(message || '').slice(0, 300),
  });
  if (stats.errorLog.length > MAX_KEY_ERRORS) {
    stats.errorLog = stats.errorLog.slice(-MAX_KEY_ERRORS);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (saved.currentIndex !== undefined) {
        state.currentIndex = saved.currentIndex % config.keys.length;
      }
      if (saved.keyStats) {
        state.keyStats = saved.keyStats;
      }
      if (saved.requestLog) {
        requestLog = saved.requestLog;
      }
    }
  } catch (err) {
    console.warn('[WARN] Could not load state, starting fresh:', err.message);
  }
  // Ensure stats array matches keys
  if (state.keyStats.length !== config.keys.length) {
    initKeyStats();
  }
}

function saveState() {
  try {
    const toSave = {
      currentIndex: state.currentIndex,
      keyStats: state.keyStats,
      requestLog: requestLog.slice(-50), // Only persist last 50 to keep file small
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[WARN] Could not save state:', err.message);
  }
}

// Auto-save every 30 seconds
setInterval(saveState, 30000);

// ─── Budget Management ───────────────────────────────────────────────────────

function checkBudget(keyIndex) {
  const keyConfig = config.keys[keyIndex];
  const stats = state.keyStats[keyIndex];

  if (!keyConfig.budget || !keyConfig.budget.amount) return true;

  const now = Date.now();
  const budgetHoursMs = (keyConfig.budget.hours || 24) * 3600 * 1000;

  // Reset budget if the window has expired
  if (stats.budgetResetAt && now >= stats.budgetResetAt) {
    stats.budgetUsed = 0;
    stats.budgetResetAt = now + budgetHoursMs;
    saveState();
  }

  // Initialize reset time
  if (!stats.budgetResetAt) {
    stats.budgetResetAt = now + budgetHoursMs;
  }

  return stats.budgetUsed < keyConfig.budget.amount;
}

function addCost(keyIndex, cost) {
  const stats = state.keyStats[keyIndex];
  stats.totalCost += cost;
  stats.budgetUsed += cost;
}

// ─── Key Selection Strategies ────────────────────────────────────────────────

function getEnabledKeys() {
  return config.keys
    .map((k, i) => ({ ...k, originalIndex: i }))
    .filter((k, i) => k.enabled !== false && checkBudget(i));
}

function getNextKeyRoundRobin() {
  const now = Date.now();
  const totalKeys = config.keys.length;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const idx = (state.currentIndex + attempt) % totalKeys;
    const keyConf = config.keys[idx];
    const stats = state.keyStats[idx];

    // Skip disabled keys
    if (keyConf.enabled === false) continue;

    // Skip budget-exceeded keys
    if (!checkBudget(idx)) continue;

    // Skip rate-limited keys
    if (stats.rateLimitedUntil && now < stats.rateLimitedUntil) continue;

    // Clear expired rate limit
    if (stats.rateLimitedUntil && now >= stats.rateLimitedUntil) {
      stats.rateLimitedUntil = null;
    }

    state.currentIndex = (idx + 1) % totalKeys;
    return idx;
  }

  return fallbackKey();
}

function getNextKeyWeighted() {
  const now = Date.now();
  const candidates = [];
  let totalWeight = 0;

  for (let i = 0; i < config.keys.length; i++) {
    const keyConf = config.keys[i];
    const stats = state.keyStats[i];

    if (keyConf.enabled === false) continue;
    if (!checkBudget(i)) continue;
    if (stats.rateLimitedUntil && now < stats.rateLimitedUntil) continue;
    if (stats.rateLimitedUntil && now >= stats.rateLimitedUntil) {
      stats.rateLimitedUntil = null;
    }

    const weight = keyConf.weight || 1;
    totalWeight += weight;
    candidates.push({ index: i, weight, cumulativeWeight: totalWeight });
  }

  if (candidates.length === 0) return fallbackKey();

  // Weighted random selection
  const roll = Math.random() * totalWeight;
  for (const c of candidates) {
    if (roll < c.cumulativeWeight) {
      return c.index;
    }
  }

  return candidates[candidates.length - 1].index;
}

function getNextKeyLeastUsed() {
  const now = Date.now();
  let bestIdx = -1;
  let leastRequests = Infinity;

  for (let i = 0; i < config.keys.length; i++) {
    const keyConf = config.keys[i];
    const stats = state.keyStats[i];

    if (keyConf.enabled === false) continue;
    if (!checkBudget(i)) continue;
    if (stats.rateLimitedUntil && now < stats.rateLimitedUntil) continue;
    if (stats.rateLimitedUntil && now >= stats.rateLimitedUntil) {
      stats.rateLimitedUntil = null;
    }

    if (stats.totalRequests < leastRequests) {
      leastRequests = stats.totalRequests;
      bestIdx = i;
    }
  }

  return bestIdx >= 0 ? bestIdx : fallbackKey();
}

function getNextKeyRandom() {
  const enabled = [];

  const now = Date.now();
  for (let i = 0; i < config.keys.length; i++) {
    const keyConf = config.keys[i];
    const stats = state.keyStats[i];

    if (keyConf.enabled === false) continue;
    if (!checkBudget(i)) continue;
    if (stats.rateLimitedUntil && now < stats.rateLimitedUntil) continue;
    if (stats.rateLimitedUntil && now >= stats.rateLimitedUntil) {
      stats.rateLimitedUntil = null;
    }

    enabled.push(i);
  }

  if (enabled.length === 0) return fallbackKey();
  return enabled[Math.floor(Math.random() * enabled.length)];
}

function fallbackKey() {
  // All keys unavailable — pick the one with shortest cooldown
  const now = Date.now();
  let bestIdx = 0;
  let shortestWait = Infinity;

  for (let i = 0; i < config.keys.length; i++) {
    if (config.keys[i].enabled === false) continue;
    const wait = (state.keyStats[i].rateLimitedUntil || 0) - now;
    if (wait < shortestWait) {
      shortestWait = wait;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function getNextKey() {
  let idx;
  const strategy = config.strategy || 'weighted-round-robin';

  switch (strategy) {
    case 'round-robin':
      idx = getNextKeyRoundRobin();
      break;
    case 'weighted-round-robin':
    case 'weighted':
      idx = getNextKeyWeighted();
      break;
    case 'least-used':
      idx = getNextKeyLeastUsed();
      break;
    case 'random':
      idx = getNextKeyRandom();
      break;
    default:
      idx = getNextKeyWeighted();
  }

  state.keyStats[idx].totalRequests++;
  state.keyStats[idx].lastUsed = new Date().toISOString();

  return { index: idx, ...config.keys[idx] };
}

function markRateLimited(keyIndex, retryAfterSec, reason) {
  const keyConf = config.keys[keyIndex] || {};
  // Priority: explicit retry-after from server > per-key default > 60s
  const seconds = retryAfterSec || keyConf.cooldownSeconds || 60;
  state.keyStats[keyIndex].rateLimitedUntil = Date.now() + seconds * 1000;
  state.keyStats[keyIndex].rateLimitedReason = reason || 'rate-limited';
  state.keyStats[keyIndex].totalErrors++;
  saveState();
  console.log(`  [COOLDOWN] Key #${keyIndex + 1} (${keyConf.label}) — ${reason || 'rate-limited'} for ${seconds}s`);
}

// ─── Per-Key Target Resolution (multi-provider support) ──────────────────────

// Resolve the upstream origin for a given key. A key may carry its own
// `baseUrl` (e.g. "https://capi.aerolink.lat") so multiple providers can be
// mixed in one rotation. Falls back to the global target when unset.
function getKeyTarget(keyConf) {
  const raw = (keyConf && (keyConf.baseUrl || keyConf.apiUrl)) ||
    `${config.targetProtocol || 'https:'}//${config.targetHost}`;
  try {
    const u = new URL(raw);
    return {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
      protocol: u.protocol,
      basePath: u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '',
      origin: `${u.protocol}//${u.host}`,
    };
  } catch (e) {
    return {
      hostname: config.targetHost,
      port: 443,
      protocol: config.targetProtocol || 'https:',
      basePath: '',
      origin: `${config.targetProtocol || 'https:'}//${config.targetHost}`,
    };
  }
}

// ─── Request Logging ─────────────────────────────────────────────────────────

function logRequest(entry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_ENTRIES) {
    requestLog = requestLog.slice(-MAX_LOG_ENTRIES);
  }
}

// ─── Token/Cost Extraction from API Responses ────────────────────────────────

function extractUsageFromBody(bodyStr) {
  try {
    const body = JSON.parse(bodyStr);
    if (body.usage) {
      return {
        inputTokens: body.usage.input_tokens || 0,
        outputTokens: body.usage.output_tokens || 0,
        cacheCreationInputTokens: body.usage.cache_creation_input_tokens || 0,
        cacheReadInputTokens: body.usage.cache_read_input_tokens || 0,
      };
    }
  } catch (e) {
    // Not JSON or no usage field
  }
  return null;
}

function calculateCost(usage) {
  if (!usage) return 0;
  // Approximate pricing (Claude Sonnet 4 via proxy — adjust as needed)
  const inputCostPer1M = 3.00;
  const outputCostPer1M = 15.00;
  const cacheWriteCostPer1M = 3.75;
  const cacheReadCostPer1M = 0.30;

  return (
    (usage.inputTokens / 1_000_000) * inputCostPer1M +
    (usage.outputTokens / 1_000_000) * outputCostPer1M +
    ((usage.cacheCreationInputTokens || 0) / 1_000_000) * cacheWriteCostPer1M +
    ((usage.cacheReadInputTokens || 0) / 1_000_000) * cacheReadCostPer1M
  );
}

// ─── Balance Checking (generic, provider-agnostic) ───────────────────────────

// Dig through a parsed JSON object for a numeric balance-like field.
function extractBalance(obj) {
  if (obj == null) return null;
  const keys = ['balance', 'credits', 'credit', 'remaining', 'remaining_credits',
    'available', 'available_balance', 'amount', 'quota_remaining', 'usage_remaining'];
  // direct hit
  for (const k of keys) {
    if (typeof obj[k] === 'number') return obj[k];
    if (typeof obj[k] === 'string' && obj[k].trim() !== '' && !isNaN(parseFloat(obj[k]))) {
      return parseFloat(obj[k]);
    }
  }
  // one level down (e.g. { data: { balance: 5 } })
  for (const nest of ['data', 'result', 'account', 'user', 'usage']) {
    if (obj[nest] && typeof obj[nest] === 'object') {
      const found = extractBalance(obj[nest]);
      if (found != null) return found;
    }
  }
  return null;
}

// Check a single key's balance against its configured balanceUrl.
// Returns a promise resolving to { ok, balance, raw, error }.
function fetchBalance(keyIndex) {
  return new Promise((resolve) => {
    const keyConf = config.keys[keyIndex];
    if (!keyConf) return resolve({ ok: false, error: 'Key not found' });

    const balanceUrl = keyConf.balanceUrl;
    if (!balanceUrl) {
      return resolve({ ok: false, error: 'No balance URL configured for this provider' });
    }

    let u;
    try { u = new URL(balanceUrl); }
    catch (e) { return resolve({ ok: false, error: 'Invalid balance URL' }); }

    const transport = u.protocol === 'http:' ? http : https;
    const options = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'x-api-key': keyConf.key,
        'Authorization': `Bearer ${keyConf.key}`,
        'Accept': 'application/json',
      },
      timeout: 12000,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          return resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 120)}` });
        }
        try {
          const parsed = JSON.parse(body);
          const bal = extractBalance(parsed);
          if (bal == null) {
            return resolve({ ok: false, error: 'No balance field found in response', raw: body.slice(0, 200) });
          }
          resolve({ ok: true, balance: bal, raw: body.slice(0, 200) });
        } catch (e) {
          resolve({ ok: false, error: 'Response was not valid JSON', raw: body.slice(0, 120) });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out' }); });
    req.end();
  });
}

// ─── API Endpoints (Management + Dashboard) ──────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

function getStatusData() {
  const now = Date.now();
  const uptimeSec = Math.floor((now - startTime) / 1000);
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const secs = uptimeSec % 60;

  let uptimeFormatted = '';
  if (hours > 0) uptimeFormatted += `${hours}h `;
  if (mins > 0 || hours > 0) uptimeFormatted += `${mins}m `;
  uptimeFormatted += `${secs}s`;

  const totalRequests = state.keyStats.reduce((s, k) => s + k.totalRequests, 0);
  const totalErrors = state.keyStats.reduce((s, k) => s + k.totalErrors, 0);

  return {
    proxy: 'Claude CLI API Key Rotation Proxy v2.0',
    uptime: uptimeSec,
    uptimeFormatted: uptimeFormatted.trim(),
    targetApi: `${config.targetProtocol}//${config.targetHost}`,
    strategy: config.strategy || 'weighted-round-robin',
    proxyPort: config.proxyPort,
    dashboardPort: config.dashboardPort,
    totalRequests,
    totalErrors,
    keys: config.keys.map((k, i) => {
      const st = state.keyStats[i] || {};
      const target = getKeyTarget(k);
      return {
        index: i,
        label: k.label,
        keyPreview: k.key.substring(0, 12) + '...',
        provider: k.provider || null,
        baseUrl: k.baseUrl || k.apiUrl || null,
        effectiveUrl: target.origin,
        balanceUrl: k.balanceUrl || null,
        cooldownSeconds: k.cooldownSeconds || null,
        enabled: k.enabled !== false,
        weight: k.weight || 1,
        totalRequests: st.totalRequests || 0,
        totalErrors: st.totalErrors || 0,
        lastUsed: st.lastUsed || null,
        rateLimitedUntil: st.rateLimitedUntil || null,
        rateLimitedReason: st.rateLimitedReason || null,
        rateLimitedRemaining: (st.rateLimitedUntil && now < st.rateLimitedUntil)
          ? Math.ceil((st.rateLimitedUntil - now) / 1000)
          : 0,
        errorLog: (st.errorLog || []).slice(-20).reverse(),
        balance: st.balance != null ? st.balance : null,
        balanceRaw: st.balanceRaw || null,
        balanceCheckedAt: st.balanceCheckedAt || null,
        balanceError: st.balanceError || null,
        budget: k.budget ? {
          amount: k.budget.amount,
          hours: k.budget.hours,
          used: st.budgetUsed || 0,
          resetAt: st.budgetResetAt ? new Date(st.budgetResetAt).toISOString() : null,
        } : null,
        cost: {
          inputTokens: st.inputTokens || 0,
          outputTokens: st.outputTokens || 0,
          totalCost: parseFloat((st.totalCost || 0).toFixed(6)),
        },
      };
    }),
  };
}

async function handleApiRequest(req, res) {
  const url = req.url;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    // GET /api/status
    if (url === '/api/status' && method === 'GET') {
      return sendJSON(res, 200, getStatusData());
    }

    // GET /api/logs
    if (url.startsWith('/api/logs') && method === 'GET') {
      const urlObj = new URL(url, 'http://localhost');
      const limit = parseInt(urlObj.searchParams.get('limit')) || 50;
      const keyFilter = urlObj.searchParams.get('key');
      let logs = requestLog.slice(-limit);
      if (keyFilter !== null && keyFilter !== undefined) {
        const ki = parseInt(keyFilter);
        logs = logs.filter(l => l.keyIndex === ki);
      }
      return sendJSON(res, 200, { logs: logs.reverse() });
    }

    // POST /api/keys — Add new key
    if (url === '/api/keys' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.label || !body.key) {
        return sendJSON(res, 400, { error: 'label and key are required' });
      }

      const newKey = {
        label: body.label,
        key: body.key,
        enabled: true,
        weight: body.weight || 1,
        budget: (body.budgetAmount && body.budgetHours) ? {
          amount: parseFloat(body.budgetAmount),
          hours: parseInt(body.budgetHours),
        } : null,
      };
      // Optional multi-provider fields
      if (body.baseUrl && String(body.baseUrl).trim()) newKey.baseUrl = String(body.baseUrl).trim();
      if (body.provider && String(body.provider).trim()) newKey.provider = String(body.provider).trim();
      if (body.balanceUrl && String(body.balanceUrl).trim()) newKey.balanceUrl = String(body.balanceUrl).trim();
      if (body.cooldownSeconds) newKey.cooldownSeconds = parseInt(body.cooldownSeconds, 10);
      config.keys.push(newKey);

      state.keyStats.push(newKeyStats(body.label));

      saveConfig();
      saveState();
      console.log(`[CONFIG] Added new key: ${body.label}`);
      return sendJSON(res, 201, { success: true, message: `Key "${body.label}" added`, totalKeys: config.keys.length });
    }

    // POST /api/keys/:index/toggle — Toggle enable/disable
    const toggleMatch = url.match(/^\/api\/keys\/(\d+)\/toggle$/);
    if (toggleMatch && method === 'POST') {
      const idx = parseInt(toggleMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      config.keys[idx].enabled = !(config.keys[idx].enabled !== false);
      saveConfig();
      console.log(`[CONFIG] Key #${idx + 1} (${config.keys[idx].label}) ${config.keys[idx].enabled ? 'ENABLED' : 'DISABLED'}`);
      return sendJSON(res, 200, { success: true, enabled: config.keys[idx].enabled });
    }

    // POST /api/keys/:index/weight — Set weight
    const weightMatch = url.match(/^\/api\/keys\/(\d+)\/weight$/);
    if (weightMatch && method === 'POST') {
      const idx = parseInt(weightMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const body = await parseBody(req);
      const weight = Math.max(1, Math.min(10, parseInt(body.weight) || 1));
      config.keys[idx].weight = weight;
      saveConfig();
      console.log(`[CONFIG] Key #${idx + 1} weight set to ${weight}`);
      return sendJSON(res, 200, { success: true, weight });
    }

    // POST /api/keys/:index/budget — Set budget
    const budgetMatch = url.match(/^\/api\/keys\/(\d+)\/budget$/);
    if (budgetMatch && method === 'POST') {
      const idx = parseInt(budgetMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const body = await parseBody(req);
      if (body.amount && body.hours) {
        config.keys[idx].budget = {
          amount: parseFloat(body.amount),
          hours: parseInt(body.hours),
        };
        // Reset budget tracking
        state.keyStats[idx].budgetUsed = 0;
        state.keyStats[idx].budgetResetAt = Date.now() + (parseInt(body.hours) * 3600 * 1000);
      } else {
        config.keys[idx].budget = null;
        state.keyStats[idx].budgetUsed = 0;
        state.keyStats[idx].budgetResetAt = null;
      }
      saveConfig();
      saveState();
      console.log(`[CONFIG] Key #${idx + 1} budget updated`);
      return sendJSON(res, 200, { success: true, budget: config.keys[idx].budget });
    }

    // POST /api/keys/:index/balance — Check balance for a key
    const balanceMatch = url.match(/^\/api\/keys\/(\d+)\/balance$/);
    if (balanceMatch && method === 'POST') {
      const idx = parseInt(balanceMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const result = await fetchBalance(idx);
      const st = state.keyStats[idx];
      st.balanceCheckedAt = new Date().toISOString();
      if (result.ok) {
        st.balance = result.balance;
        st.balanceRaw = result.raw || null;
        st.balanceError = null;
      } else {
        st.balanceError = result.error;
      }
      saveState();
      return sendJSON(res, 200, {
        success: result.ok,
        balance: result.ok ? result.balance : null,
        error: result.ok ? null : result.error,
        checkedAt: st.balanceCheckedAt,
      });
    }

    // POST /api/keys/:index/cooldown — Manually set or clear rate-limit cooldown
    const cooldownMatch = url.match(/^\/api\/keys\/(\d+)\/cooldown$/);
    if (cooldownMatch && method === 'POST') {
      const idx = parseInt(cooldownMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const body = await parseBody(req);
      const st = state.keyStats[idx];
      if (body.clear) {
        st.rateLimitedUntil = null;
        st.rateLimitedReason = null;
        console.log(`[CONFIG] Key #${idx + 1} cooldown cleared`);
      } else if (body.seconds != null) {
        const secs = Math.max(0, parseInt(body.seconds, 10) || 0);
        if (secs === 0) {
          st.rateLimitedUntil = null;
          st.rateLimitedReason = null;
        } else {
          st.rateLimitedUntil = Date.now() + secs * 1000;
          st.rateLimitedReason = 'manual';
        }
        // Persist as the key's default cooldown when explicitly set
        if (body.setDefault) config.keys[idx].cooldownSeconds = secs;
      }
      saveConfig();
      saveState();
      return sendJSON(res, 200, {
        success: true,
        rateLimitedUntil: st.rateLimitedUntil,
        cooldownSeconds: config.keys[idx].cooldownSeconds || null,
      });
    }

    // POST /api/keys/:index/provider — Update provider/baseUrl/balanceUrl for a key
    const providerMatch = url.match(/^\/api\/keys\/(\d+)\/provider$/);
    if (providerMatch && method === 'POST') {
      const idx = parseInt(providerMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const body = await parseBody(req);
      const k = config.keys[idx];
      if ('baseUrl' in body) k.baseUrl = (body.baseUrl || '').trim() || undefined;
      if ('provider' in body) k.provider = (body.provider || '').trim() || undefined;
      if ('balanceUrl' in body) k.balanceUrl = (body.balanceUrl || '').trim() || undefined;
      saveConfig();
      console.log(`[CONFIG] Key #${idx + 1} provider settings updated`);
      return sendJSON(res, 200, { success: true, baseUrl: k.baseUrl || null, provider: k.provider || null });
    }

    // POST /api/keys/:index/clear-errors — Clear a key's error log
    const clearErrMatch = url.match(/^\/api\/keys\/(\d+)\/clear-errors$/);
    if (clearErrMatch && method === 'POST') {
      const idx = parseInt(clearErrMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      state.keyStats[idx].errorLog = [];
      saveState();
      return sendJSON(res, 200, { success: true });
    }

    // DELETE /api/keys/:index — Remove key
    const deleteMatch = url.match(/^\/api\/keys\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      const idx = parseInt(deleteMatch[1]);
      if (idx < 0 || idx >= config.keys.length) {
        return sendJSON(res, 404, { error: 'Key index out of range' });
      }
      const removed = config.keys.splice(idx, 1)[0];
      state.keyStats.splice(idx, 1);
      if (state.currentIndex >= config.keys.length) {
        state.currentIndex = 0;
      }
      saveConfig();
      saveState();
      console.log(`[CONFIG] Removed key: ${removed.label}`);
      return sendJSON(res, 200, { success: true, message: `Key "${removed.label}" removed` });
    }

    // POST /api/settings — Update settings
    if (url === '/api/settings' && method === 'POST') {
      const body = await parseBody(req);
      if (body.targetHost) config.targetHost = body.targetHost;
      if (body.targetProtocol) config.targetProtocol = body.targetProtocol;
      if (body.strategy) config.strategy = body.strategy;
      if (body.proxyPort) config.proxyPort = parseInt(body.proxyPort);
      if (body.dashboardPort) config.dashboardPort = parseInt(body.dashboardPort);
      saveConfig();
      console.log(`[CONFIG] Settings updated: strategy=${config.strategy}, target=${config.targetHost}`);
      return sendJSON(res, 200, { success: true, message: 'Settings updated (hot-reloaded)' });
    }

    // POST /api/restart — Hot reload
    if (url === '/api/restart' && method === 'POST') {
      console.log('[CONFIG] Hot-reload triggered via API');
      config = loadConfig();
      initKeyStats();
      return sendJSON(res, 200, { success: true, message: 'Configuration reloaded' });
    }

    // GET /api/config — Get raw config (for CLI)
    if (url === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, config);
    }

    return sendJSON(res, 404, { error: 'API endpoint not found' });

  } catch (err) {
    console.error('[API ERROR]', err.message);
    return sendJSON(res, 500, { error: err.message });
  }
}

// ─── Proxy Core ──────────────────────────────────────────────────────────────

function proxyRequest(clientReq, clientRes) {
  // Legacy status endpoint (backward compat)
  if (clientReq.url === '/proxy-status') {
    return sendJSON(clientRes, 200, getStatusData());
  }

  // API endpoints
  if (clientReq.url.startsWith('/api/')) {
    return handleApiRequest(clientReq, clientRes);
  }

  // Dashboard
  if (clientReq.url === '/' || clientReq.url === '/dashboard') {
    return serveDashboard(clientRes);
  }

  // Actual proxy
  const requestStartTime = Date.now();
  const selectedKey = getNextKey();
  const keyNum = selectedKey.index + 1;

  // Resolve this key's upstream provider (per-key baseUrl, else global target)
  const target = getKeyTarget(selectedKey);
  const transport = target.protocol === 'http:' ? http : https;

  console.log(`\n[${new Date().toISOString()}] ${clientReq.method} ${clientReq.url}`);
  console.log(`  → Using key #${keyNum} (${selectedKey.label}) via ${target.origin}`);

  // Build headers
  const upstreamHeaders = { ...clientReq.headers };
  upstreamHeaders['x-api-key'] = selectedKey.key;
  if (upstreamHeaders['authorization']) {
    upstreamHeaders['authorization'] = `Bearer ${selectedKey.key}`;
  }
  delete upstreamHeaders['host'];

  const options = {
    hostname: target.hostname,
    port: target.port,
    path: target.basePath + clientReq.url,
    method: clientReq.method,
    headers: upstreamHeaders,
  };

  const upstreamReq = transport.request(options, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode;
    const responseTime = Date.now() - requestStartTime;

    // Collect response body to extract usage info
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.toString('utf-8');

      // Extract token usage
      const usage = extractUsageFromBody(bodyStr);
      const cost = calculateCost(usage);

      if (usage) {
        state.keyStats[selectedKey.index].inputTokens += usage.inputTokens;
        state.keyStats[selectedKey.index].outputTokens += usage.outputTokens;
        addCost(selectedKey.index, cost);
      }

      // Log the request
      const logEntry = {
        timestamp: new Date().toISOString(),
        method: clientReq.method,
        path: clientReq.url,
        keyIndex: selectedKey.index,
        keyLabel: selectedKey.label,
        statusCode,
        responseTimeMs: responseTime,
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        cost: parseFloat(cost.toFixed(6)),
      };
      logRequest(logEntry);

      // Pull a short human-readable error message from the body, if any
      function briefError() {
        try {
          const b = JSON.parse(bodyStr);
          return (b.error && (b.error.message || b.error.type)) || b.message || bodyStr.slice(0, 160);
        } catch (e) {
          return bodyStr.slice(0, 160);
        }
      }

      // Handle rate limiting & errors (recorded per key)
      if (statusCode === 429) {
        const retryAfter = parseInt(upstreamRes.headers['retry-after'], 10) || 0;
        markRateLimited(selectedKey.index, retryAfter, 'HTTP 429 rate limit');
        logKeyError(selectedKey.index, 429, `Rate limited. ${briefError()}`);
        console.log(`  ← ${statusCode} Rate Limited (retry-after: ${retryAfter || 'default'})`);
      } else if (statusCode === 401 || statusCode === 403) {
        markRateLimited(selectedKey.index, 300, `HTTP ${statusCode} auth error`);
        logKeyError(selectedKey.index, statusCode, `Auth error. ${briefError()}`);
        console.log(`  ← ${statusCode} Auth Error`);
      } else if (statusCode >= 400) {
        state.keyStats[selectedKey.index].totalErrors++;
        logKeyError(selectedKey.index, statusCode, briefError());
        console.log(`  ← ${statusCode} Error: ${briefError()}`);
      } else {
        const tokenInfo = usage ? ` [in:${usage.inputTokens} out:${usage.outputTokens} $${cost.toFixed(4)}]` : '';
        console.log(`  ← ${statusCode} OK (${responseTime}ms)${tokenInfo}`);
      }

      saveState();

      // Forward response to client
      clientRes.writeHead(statusCode, upstreamRes.headers);
      clientRes.end(bodyBuf);
    });
  });

  upstreamReq.on('error', (err) => {
    console.error(`  [ERROR] Upstream failed:`, err.message);
    state.keyStats[selectedKey.index].totalErrors++;
    logKeyError(selectedKey.index, 502, `Upstream connection failed: ${err.message}`);
    saveState();

    logRequest({
      timestamp: new Date().toISOString(),
      method: clientReq.method,
      path: clientReq.url,
      keyIndex: selectedKey.index,
      keyLabel: selectedKey.label,
      statusCode: 502,
      responseTimeMs: Date.now() - requestStartTime,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      error: err.message,
    });

    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: {
        type: 'proxy_error',
        message: `Failed to connect to upstream API: ${err.message}`,
      },
    }));
  });

  clientReq.pipe(upstreamReq, { end: true });
}

// ─── Dashboard Serving ───────────────────────────────────────────────────────

let dashboardCache = null;
let dashboardMtime = 0;

function serveDashboard(res) {
  try {
    const stat = fs.statSync(DASHBOARD_FILE);
    if (!dashboardCache || stat.mtimeMs !== dashboardMtime) {
      dashboardCache = fs.readFileSync(DASHBOARD_FILE, 'utf-8');
      dashboardMtime = stat.mtimeMs;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardCache);
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Key Rotator</title></head>
      <body style="background:#0a0e1a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h1>🔑 Key Rotator v2.0</h1>
          <p>Dashboard HTML not found. Please ensure dashboard.html exists.</p>
          <p style="color:#666">API is running. Use <code>/api/status</code> for JSON status.</p>
        </div>
      </body>
      </html>
    `);
  }
}

// ─── Server Startup ──────────────────────────────────────────────────────────

loadState();
initKeyStats();

// Merge existing state stats with freshly loaded config
for (let i = 0; i < config.keys.length; i++) {
  if (state.keyStats[i]) {
    state.keyStats[i].label = config.keys[i].label;
  }
}

const server = http.createServer(proxyRequest);

server.listen(config.proxyPort, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🔑  Claude CLI API Key Rotation Proxy v2.0               ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║   Proxy:      http://127.0.0.1:${config.proxyPort}                       ║`);
  console.log(`║   Dashboard:  http://127.0.0.1:${config.proxyPort}/dashboard              ║`);
  console.log(`║   API:        http://127.0.0.1:${config.proxyPort}/api/status             ║`);
  console.log(`║   Target:     ${config.targetProtocol}//${config.targetHost}              ║`);
  console.log(`║   Keys:       ${config.keys.length} loaded (${config.keys.filter(k => k.enabled !== false).length} active)                          ║`);
  console.log(`║   Strategy:   ${(config.strategy || 'weighted-round-robin').padEnd(30)}       ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('API Keys:');
  config.keys.forEach((k, i) => {
    const status = k.enabled !== false ? '✓' : '✗';
    const weight = `w:${k.weight || 1}`;
    const budget = k.budget ? `$${k.budget.amount}/${k.budget.hours}h` : 'no budget';
    console.log(`  ${status} #${i + 1}: ${k.label} (${k.key.substring(0, 12)}...) [${weight}] [${budget}]`);
  });
  console.log('');
  console.log('Waiting for requests...');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${config.proxyPort} is already in use.`);
    process.exit(1);
  }
  console.error('[FATAL] Server error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[INFO] Shutting down...');
  saveState();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  saveState();
  server.close(() => process.exit(0));
});
