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

  _compile() {
    // Longest-match-first prevents partial replacements
    this._anonymizeOps = [...this.mappings.entries()]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([real, alias]) => ({
        pattern: this.caseSensitive ? null : new RegExp(escapeRegExp(real), 'gi'),
        literal: real,
        replacement: alias,
      }));

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
