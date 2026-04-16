'use strict';

const http = require('http');
const https = require('https');
const { Mapper } = require('./mapper');
const { Detector } = require('./detector');

// --- Structural JSON rewriters ---------------------------------------------
// The Anthropic API returns extended-thinking blocks with cryptographically
// signed `signature` fields. Naive string replacement over the raw body can
// corrupt those signatures and cause API 400 errors on subsequent requests.
// These helpers only touch user-visible text fields in known structural
// positions; everything else (signatures, opaque ids, thinking content) is
// forwarded byte-for-byte.

function anonymizeRequestBody(bodyStr, mapper) {
  let obj;
  try { obj = JSON.parse(bodyStr); } catch { return bodyStr; }
  if (typeof obj.system === 'string') {
    obj.system = mapper.anonymize(obj.system);
  } else if (Array.isArray(obj.system)) {
    for (const block of obj.system) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        block.text = mapper.anonymize(block.text);
      }
    }
  }
  if (Array.isArray(obj.messages)) {
    for (const msg of obj.messages) {
      rewriteMessageContent(msg, (s) => mapper.anonymize(s));
    }
  }
  return JSON.stringify(obj);
}

function deanonymizeResponseBody(bodyStr, mapper) {
  let obj;
  try { obj = JSON.parse(bodyStr); } catch { return bodyStr; }
  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      rewriteContentBlock(block, (s) => mapper.deanonymize(s));
    }
  }
  if (obj.error && typeof obj.error.message === 'string') {
    obj.error.message = mapper.deanonymize(obj.error.message);
  }
  return JSON.stringify(obj);
}

function rewriteMessageContent(msg, rewrite) {
  if (!msg) return;
  if (typeof msg.content === 'string') {
    msg.content = rewrite(msg.content);
    return;
  }
  if (!Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    rewriteContentBlock(block, rewrite);
  }
}

function rewriteContentBlock(block, rewrite) {
  if (!block || typeof block !== 'object') return;
  switch (block.type) {
    case 'text':
      if (typeof block.text === 'string') {
        block.text = rewrite(block.text);
      }
      return;
    case 'tool_use':
      if (block.input && typeof block.input === 'object') {
        try {
          const s = JSON.stringify(block.input);
          const rewritten = rewrite(s);
          block.input = JSON.parse(rewritten);
        } catch { /* leave untouched */ }
      }
      return;
    case 'tool_result':
      if (typeof block.content === 'string') {
        block.content = rewrite(block.content);
      } else if (Array.isArray(block.content)) {
        for (const sub of block.content) {
          if (sub?.type === 'text' && typeof sub.text === 'string') {
            sub.text = rewrite(sub.text);
          }
        }
      }
      return;
    default:
      // thinking, redacted_thinking, and any unknown types: do not touch.
      return;
  }
}

// Transforms an SSE stream, deanonymizing aliases back to real names.
// Handles aliases that may be split across streaming chunks by buffering
// text_delta and input_json_delta events per content block.
class SSETransformer {
  constructor(mapper) {
    this.mapper = mapper;
    this.eventBuffer = '';              // raw bytes awaiting a complete SSE event
    this.textAccumulators = {};         // per-block text accumulation
    this.toolInputAccumulators = {};    // per-block tool-input accumulation
    this.blockTypes = {};               // track block types by index
  }

  // Feed a raw chunk from the upstream response. Returns transformed text to
  // forward to the client (may be empty if we're still buffering).
  transform(chunk) {
    this.eventBuffer += chunk;
    const parts = [];

    let boundary;
    while ((boundary = this.eventBuffer.indexOf('\n\n')) !== -1) {
      const raw = this.eventBuffer.slice(0, boundary + 2);
      this.eventBuffer = this.eventBuffer.slice(boundary + 2);
      parts.push(...this._processEvent(raw));
    }

    return parts.join('');
  }

  // Flush any remaining buffered data (called on stream end).
  flush() {
    const parts = [];

    if (this.eventBuffer) {
      // Forward raw — may contain partial event data including signatures.
      parts.push(this.eventBuffer);
      this.eventBuffer = '';
    }

    for (const [idx, text] of Object.entries(this.textAccumulators)) {
      if (text) {
        parts.push(this._makeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: parseInt(idx),
          delta: { type: 'text_delta', text: this.mapper.deanonymize(text) },
        }));
      }
    }
    this.textAccumulators = {};

    for (const [idx, json] of Object.entries(this.toolInputAccumulators)) {
      if (json) {
        parts.push(this._makeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: parseInt(idx),
          delta: { type: 'input_json_delta', partial_json: this.mapper.deanonymize(json) },
        }));
      }
    }
    this.toolInputAccumulators = {};

    return parts.join('');
  }

  // --- internals ---

  _processEvent(raw) {
    let eventType = '';
    let dataLine = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLine = line.slice(5).trimStart();
    }

    let data;
    try { data = JSON.parse(dataLine); } catch {
      // Unparseable — forward raw, never mutate unknown bytes.
      return [raw];
    }

    if (eventType === 'content_block_start') {
      return this._onBlockStart(data, raw);
    }
    if (eventType === 'content_block_delta') {
      return this._onBlockDelta(data, raw);
    }
    if (eventType === 'content_block_stop') {
      return this._onBlockStop(data, raw);
    }

    // All other events (message_start, message_delta, message_stop, ping, etc.)
    // message_delta carries stop_reason/usage only (no user text); forward raw.
    return [raw];
  }

  _onBlockStart(data, raw) {
    const idx = data.index;
    const type = data.content_block?.type;
    this.blockTypes[idx] = type;

    if (type === 'text') this.textAccumulators[idx] = '';
    if (type === 'tool_use') this.toolInputAccumulators[idx] = '';

    // content_block_start may include a thinking-block signature. Forward raw.
    return [raw];
  }

  _onBlockDelta(data, raw) {
    const idx = data.index;
    const deltaType = data.delta?.type;

    // --- text_delta: buffer to catch aliases split across events ---
    if (deltaType === 'text_delta' && idx in this.textAccumulators) {
      this.textAccumulators[idx] += data.delta.text;

      // If no aliases are configured, pass through immediately
      if (this.mapper.maxAliasLength === 0) {
        const text = this.textAccumulators[idx];
        this.textAccumulators[idx] = '';
        return [this._makeEvent('content_block_delta', {
          type: 'content_block_delta', index: idx,
          delta: { type: 'text_delta', text },
        })];
      }

      const buf = this.textAccumulators[idx];
      const hold = this.mapper.maxAliasLength;

      if (buf.length > hold) {
        const safe = buf.slice(0, buf.length - hold);
        this.textAccumulators[idx] = buf.slice(buf.length - hold);
        return [this._makeEvent('content_block_delta', {
          type: 'content_block_delta', index: idx,
          delta: { type: 'text_delta', text: this.mapper.deanonymize(safe) },
        })];
      }

      return []; // keep buffering
    }

    // --- input_json_delta: buffer entire tool input ---
    if (deltaType === 'input_json_delta' && idx in this.toolInputAccumulators) {
      this.toolInputAccumulators[idx] += data.delta.partial_json;
      return []; // emit on content_block_stop
    }

    // thinking_delta, signature_delta, and any other delta type:
    // forward raw — never touch signatures or thinking content.
    return [raw];
  }

  _onBlockStop(data, raw) {
    const idx = data.index;
    const results = [];

    // Flush remaining buffered text
    if (idx in this.textAccumulators && this.textAccumulators[idx]) {
      results.push(this._makeEvent('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'text_delta', text: this.mapper.deanonymize(this.textAccumulators[idx]) },
      }));
      delete this.textAccumulators[idx];
    }

    // Flush buffered tool input as a single deanonymized delta
    if (idx in this.toolInputAccumulators) {
      const fullJson = this.toolInputAccumulators[idx];
      if (fullJson) {
        results.push(this._makeEvent('content_block_delta', {
          type: 'content_block_delta', index: idx,
          delta: { type: 'input_json_delta', partial_json: this.mapper.deanonymize(fullJson) },
        }));
      }
      delete this.toolInputAccumulators[idx];
    }

    delete this.blockTypes[idx];
    results.push(raw); // forward the stop event as-is
    return results;
  }

  _makeEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// ---------------------------------------------------------------------------

function createProxy(options = {}) {
  const mapper = new Mapper(options);
  const detector = new Detector(options);
  const port = options.port || 8024;
  const upstream = options.upstream || 'https://api.anthropic.com';
  const verbose = options.verbose || false;
  const upstreamUrl = new URL(upstream);
  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  const server = http.createServer(async (clientReq, clientRes) => {
    // Health-check endpoint
    if (clientReq.url === '/health' && clientReq.method === 'GET') {
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({
        status: 'ok',
        mappings: mapper.size,
        learned: detector.size,
      }));
      return;
    }

    try {
      // Reload manual + previously learned mappings from disk
      mapper.reload();

      // Collect the full request body
      const chunks = [];
      for await (const chunk of clientReq) chunks.push(chunk);
      let body = Buffer.concat(chunks).toString('utf8');

      // Auto-detect new sensitive names and generate aliases
      const newMappings = detector.scanRequestBody(body, mapper.knownReals);
      if (newMappings.length > 0) {
        for (const { real, alias } of newMappings) mapper.addRuntime(real, alias);
        mapper.recompile();
        if (verbose) {
          console.log(`[anon-proxy] Learned ${newMappings.length} new name(s):`);
          for (const { real, alias } of newMappings) {
            console.log(`[anon-proxy]   ${real} \u2192 ${alias}`);
          }
        }
      }

      // Anonymize the request body structurally — only rewrites user-visible
      // text fields, leaving signatures and thinking blocks intact.
      const anonBody = anonymizeRequestBody(body, mapper);

      if (verbose && body !== anonBody) {
        console.log(`[anon-proxy] \u2192 Anonymized request to ${clientReq.method} ${clientReq.url}`);
      }

      // Detect streaming
      let isStreaming = false;
      if (anonBody) {
        try { isStreaming = JSON.parse(anonBody).stream === true; } catch {}
      }

      // Build forwarding headers
      const fwdHeaders = { ...clientReq.headers };
      fwdHeaders.host = upstreamUrl.hostname;
      delete fwdHeaders['accept-encoding']; // ensure uncompressed response
      if (anonBody) {
        fwdHeaders['content-length'] = Buffer.byteLength(anonBody).toString();
      }

      const upstreamReq = transport.request({
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: clientReq.url,
        method: clientReq.method,
        headers: fwdHeaders,
      }, (upstreamRes) => {
        const ct = upstreamRes.headers['content-type'] || '';

        if (isStreaming && ct.includes('text/event-stream')) {
          streamResponse(mapper, upstreamRes, clientRes, verbose);
        } else {
          bufferResponse(mapper, upstreamRes, clientRes, verbose);
        }
      });

      upstreamReq.on('error', (err) => {
        console.error(`[anon-proxy] Upstream error: ${err.message}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
        }
        clientRes.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `Upstream connection failed: ${err.message}` },
        }));
      });

      if (anonBody) upstreamReq.write(anonBody);
      upstreamReq.end();
    } catch (err) {
      console.error(`[anon-proxy] Error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { 'content-type': 'application/json' });
      }
      clientRes.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: err.message },
      }));
    }
  });

  return { server, port, mapper };
}

function streamResponse(mapper, upstreamRes, clientRes, verbose) {
  const headers = { ...upstreamRes.headers };
  delete headers['content-length']; // we'll modify the body
  clientRes.writeHead(upstreamRes.statusCode, headers);

  const transformer = new SSETransformer(mapper);

  upstreamRes.on('data', (chunk) => {
    const out = transformer.transform(chunk.toString());
    if (out) clientRes.write(out);
  });

  upstreamRes.on('end', () => {
    const remaining = transformer.flush();
    if (remaining) clientRes.write(remaining);
    clientRes.end();
    if (verbose) console.log('[anon-proxy] \u2190 Streamed response complete');
  });

  upstreamRes.on('error', (err) => {
    console.error(`[anon-proxy] Stream error: ${err.message}`);
    clientRes.end();
  });
}

function bufferResponse(mapper, upstreamRes, clientRes, verbose) {
  const chunks = [];
  upstreamRes.on('data', (chunk) => chunks.push(chunk));

  upstreamRes.on('end', () => {
    let body = Buffer.concat(chunks).toString('utf8');
    const ct = upstreamRes.headers['content-type'] || '';
    const deanon = ct.includes('application/json')
      ? deanonymizeResponseBody(body, mapper)
      : body;

    const headers = { ...upstreamRes.headers };
    headers['content-length'] = Buffer.byteLength(deanon).toString();

    clientRes.writeHead(upstreamRes.statusCode, headers);
    clientRes.end(deanon);

    if (verbose && body !== deanon) {
      console.log('[anon-proxy] \u2190 Deanonymized buffered response');
    }
  });

  upstreamRes.on('error', (err) => {
    console.error(`[anon-proxy] Response error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: err.message },
    }));
  });
}

module.exports = {
  createProxy,
  SSETransformer,
  anonymizeRequestBody,
  deanonymizeResponseBody,
};
