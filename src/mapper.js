'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_MAPPINGS_PATH = path.join(os.homedir(), '.config', 'anon-proxy', 'mappings.json');
const LEARNED_FILE = '.anon-learned.json';
const LOCAL_MAPPINGS_FILE = '.anon-mappings.json';

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
