#!/usr/bin/env node
// nv-watch.mjs — NVIDIA Game Filters store monitor.
// Watches the Overlay IndexedDB journal and logs every change NVIDIA's UI makes
// while you use Game Filters in-game (add filter, tweak value, switch slot...).
// Purpose: learn how NVIDIA actually writes to the store so the presets tool
// can mirror it faithfully.
//
// Usage:
//   node tool/nv-watch.mjs                 watch live (default, 500ms interval)
//   node tool/nv-watch.mjs --once          read current state once and print
//   node tool/nv-watch.mjs --interval 300  set poll ms
//   node tool/nv-watch.mjs --log watch.log write session log to a file
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LOCAL = process.env.LOCALAPPDATA;
const OVERLAY_DB = process.env.NV_WATCH_DB || path.join(LOCAL, 'NVIDIA Corporation', 'NVIDIA Overlay', 'CefCache', 'Default', 'IndexedDB', 'https_nvfile_0.indexeddb.leveldb');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- CRC machinery (same as nv.mjs) ----
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function crcMask(c) { c = ((c >>> 15) | (c << 17)) >>> 0; return (c + 0xa282ead8) >>> 0; }

// ---- JSON extraction (same as nv.mjs) ----
function jsonEnd(buf, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < buf.length; j++) {
    const ch = buf[j];
    if (inStr) { if (esc) esc = false; else if (ch === 0x5c) esc = true; else if (ch === 0x22) inStr = false; }
    else if (ch === 0x22) inStr = true;
    else if (ch === 0x7b) depth++;
    else if (ch === 0x7d) { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}
function findJsonBlobs(buf, needle = '{"filterPresets"') {
  const nd = Buffer.from(needle, 'latin1');
  const out = [];
  let i = 0;
  while ((i = buf.indexOf(nd, i)) >= 0) {
    const start = i;
    const end = jsonEnd(buf, start);
    if (end > 0) {
      const raw = buf.subarray(start, end).toString('latin1');
      try { out.push({ at: start, value: JSON.parse(raw) }); } catch (_) {}
    }
    i++;
  }
  return out;
}
function encodeVarint(n) {
  const b = [];
  while (true) {
    const x = n & 0x7f;
    n >>>= 7;
    if (n) b.push(x | 0x80); else { b.push(x); break; }
  }
  return Buffer.from(b);
}
function matchValueVarint(buf, v) {
  const jlen = jsonEnd(buf, v) - v;
  if (jlen <= 0) return null;
  for (let s = v - 1; s >= Math.max(0, v - 8); s--) {
    let val = 0, sh = 0;
    for (let k = 0; k < 5; k++) {
      const b = buf[s + k];
      val |= (b & 0x7f) << sh;
      if (!(b & 0x80)) {
        if (s + k + 1 === v && val === jlen) return { varStart: s, varLen: k + 1 };
        break;
      }
      sh += 7;
    }
  }
  return null;
}
function findLastPresetRecord(buf) {
  const nd = Buffer.from('{"filterPresets"', 'latin1');
  const hits = [];
  let i = 0;
  while ((i = buf.indexOf(nd, i)) >= 0) { hits.push(i); i++; }
  for (let h = hits.length - 1; h >= 0; h--) {
    const v = hits[h];
    if (!matchValueVarint(buf, v)) continue;
    const jlen = jsonEnd(buf, v) - v;
    const minH = Math.max(0, (v + jlen) - 7 - 65535);
    for (let H = v - 8; H >= minH; H--) {
      const len = buf.readUInt16LE(H + 4);
      if (buf.readUInt8(H + 6) !== 1) continue;
      if (H + 7 + len > buf.length) continue;
      if (v < H + 7 || v >= H + 7 + len) continue;
      const payload = buf.subarray(H + 7, H + 7 + len);
      const typeAndData = Buffer.concat([Buffer.from([1]), payload]);
      if (crcMask(crc32c(typeAndData)) === buf.readUInt32LE(H)) {
        return { H, len, payloadStart: H + 7, payload, v };
      }
    }
  }
  return null;
}

// ---- store reading ----
function statLogs(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.log$/i.test(f)) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      out.push({ f, size: st.size, mtimeMs: st.mtimeMs });
    } catch (_) {}
  }
  return out;
}
function readStore(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /\.(log|ldb)$/i.test(f));
  const chunks = [];
  for (const f of files) {
    let read;
    try { read = fs.readFileSync(path.join(dir, f)); } catch (_) { continue; }
    chunks.push(read);
  }
  return Buffer.concat(chunks.map(c => c.length ? c : Buffer.alloc(0)));
}
function snapshot(dir) {
  const logs = statLogs(dir);
  if (!logs || !logs.length) return null;
  const buf = readStore(dir);
  if (!buf) return null;
  const blobs = findJsonBlobs(buf);
  const rec = findLastPresetRecord(buf);
  const seq = rec ? Number(rec.payload.readBigUInt64LE(0)) : null;
  return {
    t: Date.now(),
    logs: logs.map(l => l.f + ':' + l.size).join(', '),
    bytes: buf.length,
    seq,
    lastRecLen: rec ? rec.len : null,
    blobCount: blobs.length,
    value: blobs.length ? blobs[blobs.length - 1].value : null,
    blobs: blobs,
  };
}

// ---- deep diff ----
// returns array of {path, parts, before, after}; parts = parsed path components
function deepDiff(a, b, parts = []) {
  const out = [];
  if (Object.is(a, b)) return out;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    if (!Object.is(a, b)) out.push({ parts, before: a, after: b });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    out.push(...deepDiff(a[k], b[k], [...parts, k]));
  }
  return out;
}
function pathStr(parts) {
  return parts.map(k => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : '[' + JSON.stringify(k) + ']').join('.');
}

// ---- readability helpers ----
function slotSummary(value, slotId) {
  const fp = value && value.filterPresets;
  if (!fp) return '(بدون presets)';
  const exes = Object.keys(fp);
  if (!exes.length) return '(بدون ألعاب)';
  const info = fp[exes[0]].modsSlotsInfo;
  const s = (info && info.slots || []).find(x => Number(x.id) === Number(slotId));
  const filters = ((s && s.filterStack) || {}).filters || [];
  if (!filters.length) return '(فارغ)';
  return filters.map(f => {
    const ctl = (f.controls || []).map(c => c.displayName + '=' + c.currentUIValue).join(', ');
    return f.name + '{' + ctl + '}';
  }).join('  +  ') || '(فارغ)';
}
function resolvePath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
function slotInfoOf(d) {
  const i = d.parts.indexOf('modsSlotsInfo');
  if (i < 0 || d.parts.length <= i + 2 || d.parts[i + 1] !== 'slots') return null;
  const id = Number(d.parts[i + 2]);
  if (!Number.isFinite(id)) return null;
  return { id, slotPath: d.parts.slice(0, i + 3), rest: d.parts.slice(i + 3) };
}
function humanize(diffs, beforeVal, afterVal) {
  const lines = [];
  const exeOf = (d) => (d.parts[0] === 'filterPresets' && d.parts[1]) || null;
  const filterName = (value, exe, id, fi) => {
    const v = resolvePath(value, ['filterPresets', exe, 'modsSlotsInfo', 'slots', id, 'filterStack', 'filters', fi, 'name']);
    return v == null ? '(?)' : v;
  };
  const infos = diffs.map(d => ({ d, s: slotInfoOf(d) })).filter(x => x.s);
  const slots = [...new Set(infos.map(x => x.s.id))];
  for (const id of slots) {
    const exe = exeOf(infos.find(x => x.s.id === id).d);
    const items = infos.filter(x => x.s.id === id);
    const before = slotSummary(beforeVal, id);
    const after = slotSummary(afterVal, id);
    const structural = items.filter(x => x.s.rest.length >= 3 && x.s.rest[0] === 'filterStack' && x.s.rest[1] === 'filters');
    const added = structural.find(x => x.d.before === undefined && x.d.after !== undefined && x.s.rest.length === 3);
    const removed = structural.find(x => x.d.after === undefined && x.d.before !== undefined && x.s.rest.length === 3);
    const ctlChanges = items.filter(x => x.s.rest.length >= 6 && x.s.rest[0] === 'filterStack' && x.s.rest[1] === 'filters' && x.s.rest[3] === 'controls' && x.s.rest[5] === 'currentUIValue');
    if (added || removed || ctlChanges.length) {
      if (before !== after && !(added && before === '(فارغ)')) lines.push('  slot#' + id + ': ' + (!before.includes('(فارغ)') ? before : '(فارغ)') + ' → ' + after);
    }
    for (const a of added ? [added] : []) {
      const fi = Number(a.s.rest[2]);
      const name = filterName(afterVal, exe, id, fi);
      lines.push('  slot#' + id + ': ➕ فلاتر [' + name + '] أُضيف');
    }
    for (const r of removed ? [removed] : []) {
      const fi = Number(r.s.rest[2]);
      const name = filterName(beforeVal, exe, id, fi);
      lines.push('  slot#' + id + ': ➖ فلاتر [' + name + '] أُزيل');
    }
    for (const x of ctlChanges) {
      const fi = Number(x.s.rest[2]);
      const ci = Number(x.s.rest[4]);
      const disp = resolvePath(afterVal, [...x.s.slotPath, 'filterStack', 'filters', fi, 'controls', ci, 'displayName']);
      const name = filterName(beforeVal, exe, id, fi);
      lines.push('  slot#' + id + ' ' + name + ' › ' + (disp == null ? '?' : disp) + ': ' + x.d.before + ' → ' + x.d.after);
    }
    const names = items.filter(x => x.s.rest.length === 1 && x.s.rest[0] === 'altText');
    for (const x of names) {
      const v = (n) => (n === 'settings.None' || n == null ? '(بدون)' : n);
      lines.push('  slot#' + id + ' altText: ' + v(x.d.before) + ' → ' + v(x.d.after));
    }
  }
  // changes outside slots (анselSlotsInfo, lastSlotIdx, ...)
  const misc = diffs.filter(d => !slotInfoOf(d));
  for (const d of misc.slice(0, 10)) {
    lines.push('  ' + pathStr(d.parts).slice(0, 80) + ': ' + fmtVal(d.before) + ' → ' + fmtVal(d.after));
  }
  return lines;
}
function filterLabel(value, slot, fi) {
  const fp = value && value.filterPresets;
  if (fp) {
    const exes = Object.keys(fp);
    if (exes.length) {
      const info = fp[exes[0]].modsSlotsInfo;
      const s = (info.slots || []).find(x => Number(x.id) === Number(slot));
      const f = ((s && s.filterStack) || {}).filters || [];
      if (f[fi]) return f[fi].name;
    }
  }
  return '#' + fi;
}

// ---- main watch loop ----
function printHeader() {
  console.log('NVIDIA Game Filters store watcher');
  console.log('  store: ' + OVERLAY_DB);
  console.log('  افتح اللعبة ثم Alt+F3 واستخدم الفلاتر — كل تغيير يُسجَّل هنا.');
  console.log('');
}
function main() {
  const once = process.argv.includes('--once');
  const ii = process.argv.indexOf('--interval');
  const interval = ii >= 0 ? Number(process.argv[ii + 1]) || 500 : 500;
  const li = process.argv.indexOf('--log');
  let logStream = null;
  if (li >= 0) {
    const logFile = process.argv[li + 1];
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  const line = (s) => {
    console.log(s);
    if (logStream) logStream.write(s + '\n');
  };

  if (once) {
    const snap = snapshot(OVERLAY_DB);
    if (!snap) { console.log('المخزن غير موجود أو فارغ: ' + OVERLAY_DB); return; }
    console.log('seq=' + snap.seq + ' bytes=' + snap.bytes + ' blobs=' + snap.blobCount + ' lastRec=' + snap.lastRecLen);
    for (let si = 0; si <= 3; si++) console.log('  slot#' + si + ': ' + slotSummary(snap.value, si));
    return;
  }

  printHeader();
  let prev = snapshot(OVERLAY_DB);
  if (prev) {
    line('initial: seq=' + prev.seq + ' bytes=' + prev.bytes + ' blobs=' + prev.blobCount);
  } else {
    line('⚠ المخزن غير متاح بعد — انتظر فتح اللعبة/Freestyle.');
  }
  let n = 0;
  const watchDir = path.join(ROOT, 'collected', 'watch');
  fs.mkdirSync(watchDir, { recursive: true });

  const tick = () => {
    const cur = snapshot(OVERLAY_DB);
    if (!cur) { setTimeout(tick, interval); return; }
    if (!prev || prev.logs !== cur.logs || prev.seq !== cur.seq || prev.blobCount !== cur.blobCount ||
        JSON.stringify(prev.value) !== JSON.stringify(cur.value)) {
      // let the journal settle before deep-reading (LevelDB may still be mid-write)
      setTimeout(() => {
        const settled = snapshot(OVERLAY_DB);
        if (!settled) return;
        const changed = !prev || prev.logs !== settled.logs || prev.seq !== settled.seq ||
          prev.blobCount !== settled.blobCount || JSON.stringify(prev.value) !== JSON.stringify(settled.value);
        if (!changed) return;
        n++;
        line('');
        line('[' + new Date().toLocaleTimeString() + '] التغيير #' + n);
        line('  logs: ' + (prev ? prev.logs : '∅') + '  →  ' + settled.logs);
        line('  bytes: ' + (prev ? prev.bytes : 0) + ' → ' + settled.bytes + ',  blobs: ' + (prev ? prev.blobCount : 0) + ' → ' + settled.blobCount + ',  seq: ' + (prev ? prev.seq : '∅') + ' → ' + settled.seq + ',  lastRec: ' + (prev ? prev.lastRecLen : '∅') + ' → ' + settled.lastRecLen);
        const diffs = prev && prev.value ? deepDiff(prev.value, settled.value) : [];
        if (diffs.length) {
          const friendly = humanize(diffs, prev.value, settled.value);
          if (friendly.length) { for (const l of friendly) line(l); line('  ─ تفاصيل خام:'); }
          const slice = diffs.slice(0, 60);
          for (const d of slice) line('    ' + pathStr(d.parts) + ': ' + fmtVal(d.before) + ' → ' + fmtVal(d.after));
          if (diffs.length > slice.length) line('    … و ' + (diffs.length - slice.length) + ' حقول أخرى');
        } else {
          line('  ⚠ تغيّرت البايتات لكن القيمة المفكوكة متماثلة (كتابة غير متعلقة بالفلاتر)');
        }
        const snapFile = path.join(watchDir, String(n).padStart(4, '0') + '.json');
        fs.writeFileSync(snapFile, JSON.stringify({ event: n, t: settled.t, summary: settled.value, seq: settled.seq }, null, 2));
        prev = settled;
      }, 300);
    }
    setTimeout(tick, interval);
  };
  setTimeout(tick, interval);
}
function fmtVal(v) {
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
  if (v == null) return String(v);
  return JSON.stringify(v);
}
main();