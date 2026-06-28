# 🔑 Key Rotator

A local API-key rotation **proxy + dashboard** for Anthropic-compatible endpoints
(e.g. Claude Code via a provider gateway). Point your CLI at the proxy and it spreads
traffic across multiple API keys, tracks cost/usage, enforces per-key budgets, and
backs off keys that get rate-limited.

> ⚠️ This routes requests through third-party / provider gateways. Use only keys you
> are authorized to use, and never commit your real `config.json` (it holds live keys).

## Features

- **Rotation strategies** — round-robin, weighted-round-robin, least-used, random.
- **Multi-provider** — each key can target its own API URL (`baseUrl`), so you can mix
  providers in one rotation.
- **Per-key budgets** with automatic disable and rolling reset windows.
- **Cost & token tracking** parsed from API responses.
- **Per-key error logs** — every 4xx/5xx/connection failure is recorded per key and
  visible in the dashboard.
- **Rate-limit / cooldown control** — respects `Retry-After`, with a configurable
  per-key default and manual set/clear from the UI.
- **Balance check** (generic) — if a provider exposes a balance endpoint, set
  `balanceUrl` and check it from the dashboard.
- **Sharp, boxy dashboard** with live request log, summary cards, and hot-reload.

## Quick start

1. Install [Node.js](https://nodejs.org/) (no npm dependencies required).
2. Copy the example config and add your keys:
   ```sh
   cp config.example.json config.json
   ```
   Edit `config.json` and replace the placeholder keys.
3. Start the proxy:
   ```sh
   node proxy.js
   ```
   or on Windows: `./start-proxy.ps1`
4. Open the dashboard: <http://127.0.0.1:4891/dashboard>
5. Point your client at the proxy, e.g.:
   ```sh
   export ANTHROPIC_BASE_URL=http://127.0.0.1:4891
   ```

## Configuration (`config.json`)

| Field            | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `proxyPort`      | Port the proxy + dashboard listen on (default `4891`).             |
| `targetHost`     | Default upstream host for keys without their own `baseUrl`.        |
| `targetProtocol` | `https:` or `http:`.                                               |
| `strategy`       | `round-robin` \| `weighted-round-robin` \| `least-used` \| `random`. |
| `keys[]`         | The rotation pool (see below).                                     |

Per-key fields:

| Field            | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `label`          | Display name (often the account email).                            |
| `key`            | The API key (kept local; never committed).                         |
| `enabled`        | Include in rotation.                                               |
| `weight`         | 1–10, used by weighted strategies.                                |
| `baseUrl`        | *(optional)* Per-key provider URL — enables mixing providers.      |
| `provider`       | *(optional)* Display label for the provider.                       |
| `balanceUrl`     | *(optional)* Endpoint to check this key's balance.                 |
| `cooldownSeconds`| *(optional)* Default cooldown when rate-limited without `Retry-After`. |
| `budget`         | *(optional)* `{ "amount": <usd>, "hours": <window> }`.             |

## Auto-start on Windows

```powershell
./setup-autostart.ps1   # registers a logon scheduled task
```

## Files

| File                  | Purpose                                  |
|-----------------------|------------------------------------------|
| `proxy.js`            | The proxy server + management API.       |
| `dashboard.html`      | The web dashboard UI.                    |
| `config.example.json` | Template config (copy to `config.json`). |
| `start-proxy.*`       | Launch helpers.                          |
| `setup-autostart.ps1` | Windows auto-start registration.         |

## Security

`config.json` and `.rotation-state.json` are git-ignored because they contain live
credentials and account identifiers. Keep them out of version control.
