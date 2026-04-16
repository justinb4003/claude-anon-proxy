# anon-proxy

An anonymizing proxy for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that prevents real Azure resource names, IPs, GUIDs, and other client-specific identifiers from reaching the Anthropic API.

It sits between Claude Code and Anthropic, swapping real names for generated aliases on the way out and swapping them back on the way in. Claude never sees your real infrastructure. You never notice the difference.

```
You: "Show me the SQL servers"

        +-----------+                    +-------------+
        | Your      |  real names stay   | anon-proxy  |  aliases only    Anthropic
        | terminal  | --------------->>  | (localhost)  | --------------->>  API
        |           | <<---------------- |             | <<----------------
        +-----------+  real names back   +-------------+  aliases back
```

## What gets anonymized

The proxy auto-detects sensitive data from Azure CLI output as it flows through. No configuration required.

| What | Example input | Alias |
|------|---------------|-------|
| Azure FQDNs | `acme-sql.database.windows.net` | `host-001.database.windows.net` |
| Hostnames | `acme-sql` (extracted from FQDNs) | `host-001` |
| Subscription / tenant GUIDs | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` | `00000000-0000-0000-0000-000000000001` |
| IP addresses | `10.0.1.50` | `240.0.0.1` |
| Resource groups | `rg-acme-production` | `rg-001` |
| Resource names | `vm-web-prod-01` | `res-001` |
| Admin usernames | `sqladmin_acme` | `user-001` |
| Database names | `ordersdb` | `db-001` |
| Key vault names | `acme-secrets` | `kv-001` |
| Storage accounts | `acmeproddata01` | `storage-001` |
| Pipeline names | `deploy-to-prod` | `pipeline-001` |

It recognizes 60+ Azure service domain suffixes (SQL, Storage, Key Vault, Cosmos DB, App Service, Container Registry, and many more) and extracts values from sensitive JSON fields (`resourceGroup`, `serverName`, `administratorLogin`, `fullyQualifiedDomainName`, etc.).

Things that should **not** be anonymized are left alone: Azure region names, status strings (`Succeeded`, `Running`), SKU identifiers (`Standard_B1s`), resource provider types (`Microsoft.Sql/servers`), and dates.

---

## Prerequisites

You need **Node.js 18 or later** and **npm** (which ships with Node.js). You also need **Claude Code** installed. If you already have both, skip to [Install anon-proxy](#install-anon-proxy).

### Install Node.js

#### Windows

1. Open **PowerShell** (or Terminal).
2. Download and run the official installer:
   - Go to <https://nodejs.org> and download the **LTS** installer (`.msi`).
   - Run it. Accept defaults. The installer adds `node` and `npm` to your PATH automatically.
3. Restart your terminal, then verify:
   ```powershell
   node --version
   npm --version
   ```

Alternatively, if you use **winget**:
```powershell
winget install OpenJS.NodeJS.LTS
```

Or if you use **Chocolatey**:
```powershell
choco install nodejs-lts
```

#### macOS

The easiest path is **Homebrew**. If you don't have Homebrew, install it first:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then install Node.js:
```bash
brew install node
```

Verify:
```bash
node --version
npm --version
```

Alternatively, download the macOS `.pkg` installer from <https://nodejs.org>.

#### Debian / Ubuntu

```bash
sudo apt update
sudo apt install -y nodejs npm
```

If your distro ships an older Node.js (< 18), use the NodeSource repo instead:
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

### Install Claude Code

If you don't already have Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
```

Verify it works:
```bash
claude --version
```

---

## Install anon-proxy

Clone or copy this repository, then install globally with npm:

```bash
git clone <your-repo-url> anon-proxy
cd anon-proxy
npm install -g .
```

This makes the `anon-proxy` command available everywhere. Verify:

```bash
anon-proxy
```

You should see the help text.

---

## Quick start

Three commands. That's it.

```bash
# 1. Start the proxy (runs in the background)
anon-proxy start --daemon --verbose

# 2. Tell Claude Code to route through it
export ANTHROPIC_BASE_URL=http://127.0.0.1:8024

# 3. Use Claude Code normally
claude
```

The proxy auto-learns names from Azure CLI output as you work. Run `anon-proxy learned` at any time to see what it has picked up.

### Making it permanent

To avoid setting the environment variable every time you open a terminal:

**macOS / Linux (bash):**
```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:8024' >> ~/.bashrc
source ~/.bashrc
```

**macOS / Linux (zsh):**
```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:8024' >> ~/.zshrc
source ~/.zshrc
```

**Windows (PowerShell, persistent for your user):**
```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://127.0.0.1:8024", "User")
```
Restart your terminal after running this.

### Auto-starting the proxy

If you want the proxy to start automatically when you log in:

**macOS** -- add to your shell profile:
```bash
# In ~/.zshrc or ~/.bashrc
anon-proxy start --daemon 2>/dev/null
```

**Windows** -- create a startup shortcut or scheduled task:
```powershell
# Run once to create a scheduled task that starts the proxy at login
schtasks /create /tn "anon-proxy" /tr "node %APPDATA%\npm\node_modules\anon-proxy\bin\anon-proxy start --daemon" /sc onlogon /rl limited
```

**Linux (systemd):**
```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/anon-proxy.service << 'EOF'
[Unit]
Description=anon-proxy for Claude Code

[Service]
ExecStart=/usr/bin/env node /usr/lib/node_modules/anon-proxy/bin/anon-proxy start
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now anon-proxy
```

---

## How it works

1. **Request leaves Claude Code** containing your conversation, tool results (Azure CLI output), and anything else you've discussed.
2. **anon-proxy intercepts the request.** It scans the body for sensitive patterns:
   - Regex pass: catches Azure FQDNs, GUIDs, IPv4 addresses, and resource ID paths.
   - JSON-aware pass: parses the Anthropic Messages API structure, follows nested JSON in tool results, and extracts values from known sensitive fields (`resourceGroup`, `serverName`, `administratorLogin`, etc.).
3. **New names get aliases.** Each newly detected name is assigned a deterministic alias (e.g., `host-001`, `rg-002`, `240.0.0.3`) and saved to `.anon-learned.json`.
4. **The entire request is anonymized** by replacing all known real names with their aliases, then forwarded to the Anthropic API.
5. **The response comes back** from Anthropic containing aliases. The proxy replaces them with real names before handing the response back to Claude Code.
6. **Streaming is handled correctly.** The proxy buffers SSE events to catch aliases that may be split across streaming chunks, including tool call arguments (`input_json_delta` events).

Claude reasons about `host-001.database.windows.net` and `rg-002`. You see `acme-sql.database.windows.net` and `rg-acme-production`. Anthropic's servers never see the real names.

---

## Commands

### `anon-proxy start [options]`

Start the proxy server.

| Option | Default | Description |
|--------|---------|-------------|
| `--port N` | `8024` | Port to listen on |
| `--verbose` | off | Log every anonymization event and newly learned names |
| `--daemon` | off | Run in the background (writes PID to `~/.anon-proxy.pid`) |
| `--upstream URL` | `https://api.anthropic.com` | Upstream API base URL |
| `--mappings FILE` | _(auto)_ | Use a specific manual mappings file |

```bash
# Foreground with logging (good for debugging)
anon-proxy start --verbose

# Background (typical usage)
anon-proxy start --daemon --verbose
```

### `anon-proxy stop`

Stop a proxy that was started with `--daemon`.

### `anon-proxy status`

Check whether the proxy is running and how many mappings are loaded.

### `anon-proxy learned`

Show all auto-detected mappings. This is the easiest way to verify the proxy is working.

```
$ anon-proxy learned
=== Auto-learned mappings (7) ===
    /home/you/project/.anon-learned.json
    acme-prod-sql  ->  host-001
    acme-prod-sql.database.windows.net  ->  host-001.database.windows.net
    rg-acme-production  ->  rg-001
    a1b2c3d4-e5f6-7890-abcd-ef1234567890  ->  00000000-0000-0000-0000-000000000001
    sqladmin_acme  ->  user-001
    10.0.1.50  ->  240.0.0.1
    52.188.33.44  ->  240.0.0.2
```

### `anon-proxy clear`

Delete all auto-learned mappings and start fresh. Useful when switching between client environments.

### `anon-proxy add <real-name> <alias> [--global]`

Manually map a name to a specific alias. Manual mappings override auto-learned ones.

```bash
# Per-project override (saved to .anon-mappings.json)
anon-proxy add "acme-corp" "CLIENT-A"

# Global override (saved to ~/.config/anon-proxy/mappings.json)
anon-proxy add "acme-corp" "CLIENT-A" --global
```

Use this when you want a specific alias for something the auto-detector doesn't catch (company names, custom labels, etc.).

### `anon-proxy remove <real-name> [--global]`

Remove a manual mapping.

### `anon-proxy list`

Show all manual mappings (global and local).

### `anon-proxy init`

Create a `.anon-mappings.json` template in the current directory for manual overrides.

### `anon-proxy test <text>`

Test anonymization against currently loaded mappings. Handy for verifying your setup.

```
$ anon-proxy test "Connect to acme-prod-sql.database.windows.net in rg-acme-production"
Original:    Connect to acme-prod-sql.database.windows.net in rg-acme-production
Anonymized:  Connect to host-001.database.windows.net in rg-001
Reversed:    Connect to acme-prod-sql.database.windows.net in rg-acme-production
```

---

## File layout

| File | Committed to git? | Purpose |
|------|:-:|---------|
| `bin/anon-proxy` | Yes | CLI entry point |
| `src/proxy.js` | Yes | HTTP proxy + SSE stream transformer |
| `src/mapper.js` | Yes | Bidirectional name replacement |
| `src/detector.js` | Yes | Auto-detection patterns + alias generation |
| `mappings.example.json` | Yes | Example manual mappings for reference |
| `.anon-learned.json` | **No** | Auto-detected mappings (generated, per-project) |
| `.anon-mappings.json` | **No** | Manual mapping overrides (per-project) |

Both `.anon-learned.json` and `.anon-mappings.json` are gitignored because they contain real client resource names.

### Mapping precedence

When the same real name appears in multiple sources, the last one loaded wins:

1. Global manual (`~/.config/anon-proxy/mappings.json`)
2. Auto-learned (`.anon-learned.json`)
3. Local manual (`.anon-mappings.json`) -- **highest priority**

This means a manual mapping in `.anon-mappings.json` always overrides an auto-learned alias.

---

## Sharing with teammates

The tool itself (this repo) is safe to share via git. The mapping files that contain real client names (`.anon-learned.json`, `.anon-mappings.json`) are gitignored.

### Setup for a new team member

```bash
# 1. Clone the tool
git clone <your-repo-url> anon-proxy
cd anon-proxy
npm install -g .

# 2. Start the proxy
anon-proxy start --daemon --verbose

# 3. Set the env var (and add to shell profile)
export ANTHROPIC_BASE_URL=http://127.0.0.1:8024

# 4. Start working -- names are learned automatically
claude
```

No mapping files to copy, no configuration to share. Each person's proxy learns names from their own Azure CLI output as they work.

If the team wants consistent alias names across members (so everyone calls the same server `host-001`), share the `.anon-learned.json` file through a secure channel -- password manager, encrypted share, Teams, etc. -- and drop it into the project directory.

---

## Limitations and edge cases

**First-mention leakage.** If you type a specific resource name in your very first message (before any Azure CLI output has flowed through the proxy), and it doesn't match a detectable pattern (FQDN, GUID, IP, resource ID), it will reach Anthropic un-anonymized. After the first tool result containing that name passes through, the proxy learns it and anonymizes all subsequent mentions. In practice this rarely matters because most conversations start with generic requests ("show me the servers") rather than specific names.

**Names the auto-detector can't catch.** Company names, project codenames, or other arbitrary strings that don't follow Azure naming patterns won't be auto-detected. Use `anon-proxy add` for these.

**Streaming latency.** The proxy buffers the last N characters of streaming text (where N = longest alias length) to catch aliases split across chunks. This adds roughly 50-200ms of display latency. Tool call arguments are buffered entirely until the content block completes, which can add a brief pause before a tool executes.

**Large responses.** The proxy holds full non-streaming response bodies in memory for replacement. For typical Claude Code usage this is fine. If you're processing extremely large outputs (100MB+), be aware of memory usage.

**Case sensitivity.** Real-name matching is case-insensitive by default (so `RG-ACME-PRODUCTION` and `rg-acme-production` both get caught). Alias matching on the response side is case-sensitive (aliases are generated by the proxy, so the casing is always consistent).

---

## Troubleshooting

**"Claude Code isn't connecting through the proxy."**

Verify the env var is set:
```bash
echo $ANTHROPIC_BASE_URL
# Should print: http://127.0.0.1:8024
```

Check the proxy is running:
```bash
anon-proxy status
```

If it says "Not running", start it:
```bash
anon-proxy start --daemon --verbose
```

**"Names aren't being anonymized."**

Start the proxy with `--verbose` and look at the log output. You should see `Learned N new name(s)` and `Anonymized request` messages. If you don't see any learning, the data may not contain patterns the detector recognizes -- use `anon-proxy add` for those names.

**"I switched clients and old aliases are interfering."**

```bash
anon-proxy clear
```

This resets the auto-learned mappings. The proxy will re-learn from the new client's data.

**"The proxy won't start -- port already in use."**

Use a different port:
```bash
anon-proxy start --daemon --port 8025
export ANTHROPIC_BASE_URL=http://127.0.0.1:8025
```

Or stop the existing proxy first:
```bash
anon-proxy stop
```

---

## Uninstall

```bash
anon-proxy stop
npm uninstall -g anon-proxy
```

Remove the `ANTHROPIC_BASE_URL` line from your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) or delete the user environment variable on Windows:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", $null, "User")
```
