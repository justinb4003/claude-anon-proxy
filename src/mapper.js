'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_MAPPINGS_PATH = path.join(os.homedir(), '.config', 'anon-proxy', 'mappings.json');
const LEARNED_FILE = '.anon-learned.json';
const LOCAL_MAPPINGS_FILE = '.anon-mappings.json';

// Built-in passthrough allowlist. These public model / service names are
// mapped to themselves so they pass through unchanged — and so the detector's
// `manualReals` check skips them during aggressive learning. Keeps assistant
// context readable instead of turning "gpt-4.1-mini" into "res-017".
const BUILTIN_PASSTHROUGH = [
  // OpenAI / Azure OpenAI chat model families
  'gpt-3.5-turbo',
  'gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.2',
  'o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini',
  // Embeddings
  'text-embedding-ada-002',
  'text-embedding-3-small', 'text-embedding-3-large',
  // Image / audio
  'dall-e-2', 'dall-e-3', 'whisper-1', 'tts-1', 'tts-1-hd',
  // Mistral on Azure
  'mistral-large', 'mistral-large-2407', 'mistral-small',
  'mistral-document-ai', 'mistral-document-ai-2512',
  // Anthropic Claude (in case Claude Code traffic references model IDs)
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Anchored GUID test — used to decide which mappings need a case-insensitive
// substitution. GUIDs are commonly written in either case in Azure CLI output,
// code, and docs; we learn them lowercased, so a literal-only match would miss
// uppercase occurrences and leak them upstream.
const GUID_TEST_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Mapper {
  constructor(options = {}) {
    this.caseSensitive = options.caseSensitive ?? true;
    // Load order: global manual → learned (auto-detected) → local manual (overrides)
    this._files = options.mappingFiles || [
      GLOBAL_MAPPINGS_PATH,
      path.resolve(LEARNED_FILE),
      path.resolve(LOCAL_MAPPINGS_FILE),
    ];
    this.mappings = new Map();   // real name -> alias
    this.reverse = new Map();    // alias -> real name
    this._anonymizeOps = [];
    this._deanonymizeOps = [];
    this.maxAliasLength = 0;
    this.maxRealLength = 0;

    this.reload();
  }

  reload() {
    this.mappings.clear();
    this.reverse.clear();

    // Seed with built-in passthroughs first; file-based mappings below may
    // override any of these if the user wants different behavior.
    for (const name of BUILTIN_PASSTHROUGH) {
      this.mappings.set(name, name);
      this.reverse.set(name, name);
    }

    for (const file of this._files) {
      this._loadFile(file);
    }
    this._compile();
  }

  _loadFile(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Manual mappings format: { "mappings": { "real": "alias" } }
      if (data.mappings) {
        for (const [real, alias] of Object.entries(data.mappings)) {
          if (typeof alias !== 'string') continue;
          this.mappings.set(real, alias);
          this.reverse.set(alias, real);
        }
      }

      // Learned mappings format: { "learned": { "real": { "alias": "...", ... } } }
      if (data.learned) {
        for (const [real, info] of Object.entries(data.learned)) {
          if (typeof info === 'object' && typeof info.alias === 'string') {
            this.mappings.set(real, info.alias);
            this.reverse.set(info.alias, real);
          }
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`[anon-proxy] Warning: could not load ${filePath}: ${e.message}`);
      }
    }
  }

  // Add a mapping at runtime (in-memory only, not persisted to manual file)
  addRuntime(real, alias) {
    this.mappings.set(real, alias);
    this.reverse.set(alias, real);
  }

  // Rebuild sorted replacement lists after runtime additions
  recompile() {
    this._compile();
  }

  // Set of all known real names (for the detector to check against)
  get knownReals() {
    return new Set(this.mappings.keys());
  }

  // Set of all alias strings — passed to the detector so it never re-aliases
  // one of our own aliases that may have leaked back into outbound text.
  get knownAliases() {
    return new Set(this.reverse.keys());
  }

  _compile() {
    // Longest-match-first prevents partial replacements.
    // Force case-insensitive matching for GUID-shaped reals even in case-
    // sensitive mode — they're stored lowercase but commonly appear uppercase
    // in CLI output.
    this._anonymizeOps = [...this.mappings.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([real, alias]) => {
        const useRegex = !this.caseSensitive || GUID_TEST_RE.test(real);
        return {
          pattern: useRegex ? new RegExp(escapeRegExp(real), 'gi') : null,
          literal: real,
          replacement: alias,
        };
      });

    this._deanonymizeOps = [...this.reverse.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([alias, real]) => ({
        literal: alias,
        replacement: real,
      }));

    this.maxAliasLength = this.reverse.size > 0
      ? Math.max(...[...this.reverse.keys()].map(k => k.length))
      : 0;
    this.maxRealLength = this.mappings.size > 0
      ? Math.max(...[...this.mappings.keys()].map(k => k.length))
      : 0;
  }

  // Replace real names with aliases (outbound to Anthropic)
  anonymize(text) {
    if (!text || this._anonymizeOps.length === 0) return text;
    for (const op of this._anonymizeOps) {
      if (op.pattern) {
        text = text.replace(op.pattern, op.replacement);
      } else {
        text = text.replaceAll(op.literal, op.replacement);
      }
    }
    return text;
  }

  // Replace aliases with real names (inbound from Anthropic)
  deanonymize(text) {
    if (!text || this._deanonymizeOps.length === 0) return text;
    for (const op of this._deanonymizeOps) {
      text = text.replaceAll(op.literal, op.replacement);
    }
    return text;
  }

  get size() {
    return this.mappings.size;
  }

  // --- Static helpers for managing mapping files ---

  static addMapping(filePath, real, alias) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!data.mappings) data.mappings = {};
    data.mappings[real] = alias;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  static removeMapping(filePath, real) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error(`Cannot read ${filePath}: ${e.message}`);
      return false;
    }
    if (!data.mappings || !(real in data.mappings)) {
      console.error(`"${real}" not found in ${filePath}`);
      return false;
    }
    delete data.mappings[real];
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return true;
  }

  static listMappings(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data.mappings || {};
    } catch {
      return {};
    }
  }

  static initFile(filePath) {
    if (fs.existsSync(filePath)) {
      return false;
    }
    const template = {
      mappings: {
        'your-server-name': 'SERVER-A',
        'your-pipeline-name': 'PIPELINE-A',
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n');
    return true;
  }
}

module.exports = { Mapper, GLOBAL_MAPPINGS_PATH, LEARNED_FILE, LOCAL_MAPPINGS_FILE };
