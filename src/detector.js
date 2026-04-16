'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Azure service domain suffixes — anything matching these is a real resource
// ---------------------------------------------------------------------------
const AZURE_DOMAINS = [
  // SQL
  'database.windows.net',
  // Storage
  'blob.core.windows.net', 'table.core.windows.net', 'queue.core.windows.net',
  'file.core.windows.net', 'dfs.core.windows.net',
  // Key Vault / HSM
  'vault.azure.net', 'vaultcore.azure.net', 'managedhsm.azure.net',
  // Web / Functions
  'azurewebsites.net', 'scm.azurewebsites.net', 'azurestaticapps.net',
  // Containers
  'azurecr.io', 'azurecontainer.io',
  // Cache
  'redis.cache.windows.net',
  // Messaging
  'servicebus.windows.net', 'eventgrid.azure.net',
  // Cosmos DB
  'documents.azure.com', 'mongo.cosmos.azure.com',
  'cassandra.cosmos.azure.com', 'gremlin.cosmos.azure.com',
  'table.cosmos.azure.com',
  // Managed databases
  'postgres.database.azure.com', 'mysql.database.azure.com',
  'mariadb.database.azure.com',
  // AI / ML / Search
  'cognitiveservices.azure.com', 'openai.azure.com',
  'api.azureml.ms', 'search.windows.net',
  // Networking / CDN
  'azurefd.net', 'trafficmanager.net', 'cloudapp.azure.com',
  'azure-api.net', 'azureedge.net',
  // Analytics
  'azuresynapse.net', 'dev.azuresynapse.net', 'sql.azuresynapse.net',
  'kusto.windows.net', 'azuredatabricks.net',
  'analysis.windows.net', 'pbidedicated.windows.net',
  // Data Factory / Logic / IoT
  'datafactory.azure.net', 'logic.azure.com',
  'azureiot.net', 'azure-devices.net', 'azure-devices-provisioning.net',
  // Misc
  'signalr.net', 'communication.azure.com', 'purview.azure.com',
  'digitaltwins.azure.net', 'media.azure.net', 'batch.azure.com',
  'notebooks.azure.net', 'azurehealthcareapis.com',
  'fabric.microsoft.com', 'powerbi.com',
];

// Pre-compile the FQDN regex (longest domain first to avoid partial matches)
const _domainRe = AZURE_DOMAINS
  .sort((a, b) => b.length - a.length)
  .map(d => d.replace(/\./g, '\\.'))
  .join('|');
const FQDN_RE = new RegExp(
  `([a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,253}[a-zA-Z0-9])?)\\.(${_domainRe})`,
  'gi',
);

const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const IPV4_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const SKIP_IPS = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255']);

const RESOURCE_ID_RE =
  /\/subscriptions\/[0-9a-f-]{36}\/resource[Gg]roups\/([^/\s"'\\]+)(?:\/providers\/[^/\s"'\\]+\/[^/\s"'\\]+\/([^/\s"'\\]+))?/gi;

// ---------------------------------------------------------------------------
// JSON field extraction — keys whose values are likely client-specific names
// ---------------------------------------------------------------------------
const SENSITIVE_FIELDS = new Set([
  'resourcegroup', 'servername', 'databasename', 'vaultname',
  'storageaccountname', 'accountname', 'containername', 'registryname',
  'clustername', 'workspacename', 'factoryname', 'namespacename',
  'sitename', 'hostname', 'fullyqualifieddomainname', 'fqdn',
  'adminusername', 'administratorlogin', 'principalname',
  'userprincipalname', 'displayname',
  'virtualnetworkname', 'subnetname', 'networksecuritygroupname',
  'publicipaddressname', 'loadbalancername', 'applicationgatewayname',
  'keyvaultname', 'cachename', 'appname', 'functionappname',
  'pipelinename',
]);

// Values we should never anonymize
const AZURE_REGIONS = new Set([
  'eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'centralus',
  'northcentralus', 'southcentralus', 'westcentralus', 'canadacentral',
  'canadaeast', 'brazilsouth', 'northeurope', 'westeurope', 'uksouth',
  'ukwest', 'francecentral', 'germanywestcentral', 'switzerlandnorth',
  'norwayeast', 'swedencentral', 'eastasia', 'southeastasia', 'japaneast',
  'japanwest', 'koreacentral', 'centralindia', 'australiaeast',
  'australiasoutheast', 'uaenorth', 'southafricanorth', 'qatarcentral',
  'israelcentral', 'italynorth', 'polandcentral', 'spaincentral',
  'mexicocentral', 'newzealandnorth',
]);

const SKIP_VALUES = new Set([
  ...AZURE_REGIONS,
  'succeeded', 'failed', 'running', 'stopped', 'creating', 'deleting',
  'updating', 'provisioning', 'ready', 'notready', 'enabled', 'disabled',
  'active', 'inactive', 'standard', 'premium', 'basic', 'free',
  'true', 'false', 'none', 'null', 'yes', 'no',
  'systemassigned', 'userassigned', 'both',
  'allow', 'deny', 'default', 'microsoft', 'azure',
]);

function _skipValue(val) {
  if (!val || val.length < 2 || val.length > 200) return true;
  if (SKIP_VALUES.has(val.toLowerCase())) return true;
  if (/^\d+(\.\d+)*$/.test(val)) return true;           // numbers / versions
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return true;      // dates
  if (/^[A-Z][a-z]+_[A-Z]\w*/.test(val)) return true;   // SKU-like: Standard_B1s
  if (/^Microsoft\.\w+\/\w+/.test(val)) return true;     // resource provider type
  return false;
}

// Heuristic: does this string look like a resource identifier rather than a
// plain word or sentence? Used in aggressive (az-sourced) learning to avoid
// aliasing common words like "Enabled" or "North".
function _looksLikeIdentifier(s) {
  if (s.length < 3 || s.length > 120) return false;
  if (/\s/.test(s)) return false;                         // no spaces
  if (!/^[A-Za-z0-9]/.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;                  // must contain a letter
  if (/[-_]/.test(s)) return true;                        // kebab / snake
  if (/[a-z][A-Z]/.test(s)) return true;                  // camelCase
  if (/\d/.test(s) && /[A-Za-z]/.test(s)) return true;    // mixed alpha+digit
  if (/\./.test(s) && !/^\d/.test(s)) return true;        // dotted (fqdn-ish)
  return false;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

class Detector {
  constructor(options = {}) {
    this.persistPath = path.resolve(options.learnedPath || '.anon-learned.json');
    this.learned = new Map();   // real → { alias, category }
    this.counters = {};
    this._load();
  }

  /**
   * Scan an Anthropic Messages API request body for sensitive Azure names.
   * Returns an array of { real, alias } for newly detected names.
   *
   * @param {string} body  Raw JSON request body
   * @param {Set<string>} manualReals  Already-mapped real names (from manual mappings)
   */
  scanRequestBody(body, manualReals = new Set()) {
    const newMappings = [];
    const justSeen = new Set();

    const learn = (real, category) => {
      if (!real || real.length < 2) return;
      if (manualReals.has(real)) return;
      if (this.learned.has(real)) return;
      if (justSeen.has(real)) return;
      const alias = this._alias(category);
      this.learned.set(real, { alias, category });
      newMappings.push({ real, alias });
      justSeen.add(real);
    };

    // Helper for learning FQDNs (hostname + full FQDN together)
    const learnFqdn = (hostname, domain) => {
      learn(hostname, 'hostname');
      const fqdn = `${hostname}.${domain}`;
      // If the hostname has a manual mapping, skip the FQDN — the mapper's
      // substring replacement will catch it naturally.
      if (manualReals.has(hostname)) return;
      if (manualReals.has(fqdn) || this.learned.has(fqdn) || justSeen.has(fqdn)) return;
      const hostAlias = this.learned.get(hostname)?.alias || hostname;
      const fqdnAlias = `${hostAlias}.${domain}`;
      this.learned.set(fqdn, { alias: fqdnAlias, category: 'fqdn' });
      newMappings.push({ real: fqdn, alias: fqdnAlias });
      justSeen.add(fqdn);
    };

    // --- Phase 1: regex patterns on the raw body string ---
    this._scanPatterns(body, learn, learnFqdn);

    // --- Phase 2: JSON-aware extraction from message content ---
    this._scanApiJson(body, learn, learnFqdn, manualReals, justSeen);

    if (newMappings.length > 0) this._save();
    return newMappings;
  }

  // ---- regex patterns on raw text ----------------------------------------

  _scanPatterns(text, learn, learnFqdn) {
    let m;

    FQDN_RE.lastIndex = 0;
    while ((m = FQDN_RE.exec(text)) !== null) learnFqdn(m[1], m[2]);

    RESOURCE_ID_RE.lastIndex = 0;
    while ((m = RESOURCE_ID_RE.exec(text)) !== null) {
      if (m[1]) learn(m[1], 'resource_group');
      if (m[2]) learn(m[2], 'resource');
    }

    GUID_RE.lastIndex = 0;
    while ((m = GUID_RE.exec(text)) !== null) learn(m[0].toLowerCase(), 'guid');

    IPV4_RE.lastIndex = 0;
    while ((m = IPV4_RE.exec(text)) !== null) {
      const ip = m[1];
      if (SKIP_IPS.has(ip) || ip.startsWith('240.0.')) continue;
      const octets = ip.split('.').map(Number);
      if (octets.some(o => o > 255)) continue;
      learn(ip, 'ipv4');
    }
  }

  // ---- JSON-aware extraction from the API request body --------------------

  _scanApiJson(body, learn, learnFqdn, manualReals, justSeen) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }

    // Correlate tool_use → tool_result: collect tool_use ids whose command
    // warrants aggressive learning (az CLI, db CLIs, Python scripts).
    const aggressiveToolUseIds = new Set();
    for (const msg of parsed.messages || []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && this._wantsAggressive(block) && block.id) {
          aggressiveToolUseIds.add(block.id);
        }
      }
    }

    const deepScan = (text, aggressive = false) => {
      // Try to parse as JSON (Azure CLI output is typically JSON)
      try {
        const obj = JSON.parse(text);
        this._walkAzureObject(obj, learn, 0, aggressive);
      } catch {
        // Not JSON — if we know it came from `az`, try table-format parsing
        if (aggressive) this._scanAzTable(text, learn);
      }
      // Also run regex patterns on the decoded string (catches things
      // that were double-escaped in the outer JSON)
      this._scanPatterns(text, learn, learnFqdn);
    };

    const scanResultContent = (content, aggressive) => {
      if (typeof content === 'string') { deepScan(content, aggressive); return; }
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.text) deepScan(block.text, aggressive);
        if (block.type === 'tool_result') scanResultContent(block.content, aggressive);
      }
    };

    // System prompt
    if (typeof parsed.system === 'string') deepScan(parsed.system);
    if (Array.isArray(parsed.system)) {
      for (const b of parsed.system) { if (b.text) deepScan(b.text); }
    }

    // Messages — route tool_result scanning with the az-source flag.
    for (const msg of parsed.messages || []) {
      if (typeof msg.content === 'string') { deepScan(msg.content); continue; }
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) deepScan(block.text);
        if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
          try { deepScan(JSON.stringify(block.input)); } catch { /* ignore */ }
        }
        if (block.type === 'tool_result') {
          const aggressive = aggressiveToolUseIds.has(block.tool_use_id);
          scanResultContent(block.content, aggressive);
        }
      }
    }
  }

  // Does this tool_use block's command warrant aggressive learning?
  // Matches the `az` CLI, common database clients, and Python-family
  // interpreters. Python triggers aggressive mode unconditionally since we
  // can't see inside the script — accepted as a tradeoff for coverage.
  // (String literals use \x73 escapes for the letter before "ql" to avoid
  // interaction with outbound substring replacement of "\x73ql" tokens.)
  _wantsAggressive(block) {
    if (block.name !== 'Bash') return false;
    const cmd = block.input?.command;
    if (typeof cmd !== 'string') return false;
    const boundary = '(^|[\\s;&|`(])';
    const tools = [
      'az',
      '\x73qlcmd', 'p\x73ql', 'my\x73ql', '\x73qlite3',
      'mongosh', 'redis-cli', 'm\x73\x73ql-cli', 'pgcli', 'mycli', 'iredis',
      'python', 'python3', 'ipython', 'jupyter',
    ].join('|');
    return new RegExp(`${boundary}(${tools})\\s`).test(cmd);
  }

  // Walk a parsed Azure JSON object (e.g. CLI output) and extract values
  // from known sensitive fields. In aggressive mode (az-sourced), learn
  // every string value that looks like an identifier.
  _walkAzureObject(obj, learn, depth, aggressive = false) {
    if (depth > 10) return;
    if (Array.isArray(obj)) {
      for (const item of obj) this._walkAzureObject(item, learn, depth + 1, aggressive);
      return;
    }
    if (typeof obj !== 'object' || obj === null) return;

    // An Azure resource typically has "id" starting with /subscriptions/
    const isResource =
      typeof obj.id === 'string' && /^\/subscriptions\//i.test(obj.id);

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.length >= 2 && !_skipValue(value)) {
        const lk = key.toLowerCase();
        const isSensitive = SENSITIVE_FIELDS.has(lk);
        const isResourceName = lk === 'name' && isResource;

        if (isSensitive || isResourceName) {
          learn(value, _categorizeField(key));
        } else if (aggressive && _looksLikeIdentifier(value)) {
          learn(value, _categorizeField(key));
        }
      }
      if (typeof value === 'object') {
        this._walkAzureObject(value, learn, depth + 1, aggressive);
      }
    }
  }

  // Parse `az … -o table` output: header line, dashed separator, then rows
  // aligned by column. Learn identifier-ish values from each cell.
  _scanAzTable(text, learn) {
    const lines = text.split('\n');
    let headerIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const sep = lines[i + 1];
      if (/^[\s-]+$/.test(sep) && sep.includes('---') && lines[i].trim()) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) return;

    // Column spans come from runs of dashes in the separator row.
    const sep = lines[headerIdx + 1];
    const cols = [];
    const re = /-+/g;
    let m;
    while ((m = re.exec(sep)) !== null) {
      cols.push({ start: m.index, end: m.index + m[0].length });
    }
    if (cols.length === 0) return;

    const header = lines[headerIdx];
    const headerNames = cols.map(c =>
      header.slice(c.start, c.end).trim().toLowerCase());

    for (let i = headerIdx + 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      for (let j = 0; j < cols.length; j++) {
        const { start, end } = cols[j];
        // Last column runs to EOL to capture wider values.
        const v = (j === cols.length - 1
          ? line.slice(start)
          : line.slice(start, end)).trim();
        if (!v || _skipValue(v)) continue;
        if (!_looksLikeIdentifier(v)) continue;
        learn(v, _categorizeField(headerNames[j] || 'name'));
      }
    }
  }

  // ---- alias generation ---------------------------------------------------

  _alias(category) {
    if (!this.counters[category]) this.counters[category] = 1;
    const n = this.counters[category]++;
    const p = (x, len = 3) => String(x).padStart(len, '0');

    switch (category) {
      case 'hostname':       return `host-${p(n)}`;
      case 'guid':           return `00000000-0000-0000-0000-${p(n, 12)}`;
      case 'ipv4':           return `240.0.${Math.floor((n - 1) / 256)}.${((n - 1) % 256) + 1}`;
      case 'resource_group': return `rg-${p(n)}`;
      case 'resource':       return `res-${p(n)}`;
      case 'user':           return `user-${p(n)}`;
      case 'database':       return `db-${p(n)}`;
      case 'keyvault':       return `kv-${p(n)}`;
      case 'storage':        return `storage-${p(n)}`;
      case 'container':      return `container-${p(n)}`;
      case 'cluster':        return `cluster-${p(n)}`;
      case 'workspace':      return `workspace-${p(n)}`;
      case 'factory':        return `factory-${p(n)}`;
      case 'namespace':      return `namespace-${p(n)}`;
      case 'network':        return `network-${p(n)}`;
      case 'pipeline':       return `pipeline-${p(n)}`;
      default:               return `anon-${p(n)}`;
    }
  }

  // ---- persistence --------------------------------------------------------

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.counters = data.counters || {};
      for (const [real, info] of Object.entries(data.learned || {})) {
        this.learned.set(real, info);
      }
    } catch (e) {
      if (e.code !== 'ENOENT')
        console.error(`[anon-proxy] Warning: could not load ${this.persistPath}: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify({
        counters: this.counters,
        learned: Object.fromEntries(this.learned),
      }, null, 2) + '\n');
    } catch (e) {
      console.error(`[anon-proxy] Warning: could not persist learned mappings: ${e.message}`);
    }
  }

  get size() { return this.learned.size; }

  getMappings() {
    const m = {};
    for (const [real, { alias }] of this.learned) m[real] = alias;
    return m;
  }

  clear() {
    this.learned.clear();
    this.counters = {};
    try { fs.unlinkSync(this.persistPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _categorizeField(fieldName) {
  const lk = fieldName.toLowerCase();
  if (lk.includes('resourcegroup'))    return 'resource_group';
  if (lk.includes('server') || lk.includes('hostname') || lk.includes('fqdn'))
                                       return 'hostname';
  if (lk.includes('pipeline'))         return 'pipeline';
  if (lk.includes('ipaddress') || lk === 'ipaddress')
                                       return 'ipv4';
  if (lk.includes('admin') || lk.includes('login') || lk.includes('principal') || lk.includes('username'))
                                       return 'user';
  if (lk.includes('database'))         return 'database';
  if (lk.includes('vault'))            return 'keyvault';
  if (lk.includes('storage') || lk.includes('account'))
                                       return 'storage';
  if (lk.includes('container') || lk.includes('registry'))
                                       return 'container';
  if (lk.includes('cluster'))          return 'cluster';
  if (lk.includes('workspace'))        return 'workspace';
  if (lk.includes('factory'))          return 'factory';
  if (lk.includes('namespace'))        return 'namespace';
  if (lk.includes('subnet') || lk.includes('network'))
                                       return 'network';
  return 'resource';
}

module.exports = { Detector };
