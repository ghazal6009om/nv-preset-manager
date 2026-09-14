#!/usr/bin/env node
// NV Preset Manager — works with NVIDIA's own Freestyle/Ansel slot storage.
// Commands:
//   slots            print the current saved slots (from NVIDIA Overlay store)
//   export <name>    save current Genshin filterPresets JSON to collected\<name>.nvpreset.json
//   import <slot> <preset[,preset...]>  apply a library preset into a live slot (close NVIDIA App first)
//   backup [label]   make full snapshot of NVIDIA nvfile store (App + Overlay) into backups\
//   restore <label>  restore a snapshot back (close NVIDIA App/game first)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const LOCAL = process.env.LOCALAPPDATA;
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERED_FILE = path.join(TOOL_DIR, 'discovered-filters.json');
const OVERLAY_DB = process.env.NV_OVERLAY_DB || path.join(LOCAL, 'NVIDIA Corporation', 'NVIDIA Overlay', 'CefCache', 'Default', 'IndexedDB', 'https_nvfile_0.indexeddb.leveldb');
const APP_DB = path.join(LOCAL, 'NVIDIA Corporation', 'NVIDIA App', 'CefCache', 'Default', 'IndexedDB', 'https_nvfile_0.indexeddb.leveldb');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTED = path.join(ROOT, 'collected');
const BACKUPS = path.join(ROOT, 'backups');

import { fileURLToPath } from 'node:url';

// ---- JSON extraction from NVIDIA's store (ASCII-safe blob scan) ----
function findJsonBlobs(buf, needle = '{"filterPresets"') {
  const nd = Buffer.from(needle, 'latin1');
  const out = [];
  let i = 0;
  while ((i = buf.indexOf(nd, i)) >= 0) {
    const start = i; // at '{'
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < buf.length; j++) {
      const ch = buf[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === 0x5c) esc = true;
        else if (ch === 0x22) inStr = false;
      } else {
        if (ch === 0x22) inStr = true;
        else if (ch === 0x7b) depth++;
        else if (ch === 0x7d) { depth--; if (depth === 0) { end = j + 1; break; } }
      }
    }
    if (end > 0) {
      const raw = buf.subarray(start, end).toString('latin1');
      try { out.push(JSON.parse(raw)); } catch (_) {}
    }
    i++;
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

function currentFilterPresets() {
  const buf = readStore(OVERLAY_DB);
  if (!buf) return null;
  const blobs = findJsonBlobs(buf);
  return blobs.length ? blobs[blobs.length - 1] : null;
}

function isStoreBusy() {
  // هل يتولّى NVIDIA App/Overlay المخزن الآن؟ (الكتابة أثناء ذلك تُفشل أو تُهمَل)
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return /NVIDIA Overlay|NVIDIA App/i.test(out);
  } catch (_) {
    return false;
  }
}

function stackFromExportFile(file, slot) {
  // يدعم ملفات التصدير الخام (.nvpreset.json ببنية filterPresets) —
  // يستخرج مكدس الخانة المطلوبة كما هو (يشمل فلاتر أصلية وغير معروفة).
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!obj || !obj.filterPresets) return null;
  for (const exe of Object.keys(obj.filterPresets)) {
    const info = obj.filterPresets[exe].modsSlotsInfo;
    if (!info) continue;
    const s = (info.slots || []).find(x => Number(x.id) === Number(slot));
    if (s && s.filterStack) return s.filterStack.filters;
  }
  return null;
}

function slotReadout(fp, slot) {
  // قراءة اسماء الخانة وقيمها من بيانات المخزنة لفحص التطبيق
  let filters = [];
  if (fp && fp.filterPresets) {
    for (const exe of Object.keys(fp.filterPresets)) {
      const info = fp.filterPresets[exe].modsSlotsInfo;
      if (!info) continue;
      const s = (info.slots || []).find(x => Number(x.id) === Number(slot));
      if (s && s.filterStack) filters = s.filterStack.filters;
      break;
    }
  }
  return filters.map(f => f.name + '{' + (f.controls || []).map(c => c.displayName + '=' + c.currentUIValue).join(', ') + '}').join(' + ') || '(فارغ)';
}

// ---- LevelDB log append (يرفع القيد: السجل الحالي قد يكون أصغر من القيمة) ----
// CRC-32C (Castagnoli) مع Mask كما تستخدمه CEF/LevelDB:
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

const LOG_BLOCK = 32768;

function jsonEnd(buf, start) {
  // end index (after closing brace) of the JSON object starting at `start`, or -1
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

function encodeVarint(n) {
  const b = [];
  while (true) {
    const x = n & 0x7f;
    n >>>= 7;
    if (n) b.push(x | 0x80); else { b.push(x); break; }
  }
  return Buffer.from(b);
}

// يعود بـ {varStart, varLen} إذا كانت أطوال الـ varint قبل JSON تطابق طوله تماماً
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

// آخر سجل FULL (يبدأ بـ header صحيح CRC) يحتوي على قيمة الفلاتر — قد يكون أطول من نافذة واحدة
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
  throw new Error('تعذّر العثور على السجل الأخير الحاوي على الفلاتر.');
}

function lastValueOffset(buf) {
  try { return findLastPresetRecord(buf).v; } catch (_) { return -1; }
}

function appendValue(dir, newValueObj) {
  // ينسخ السجل الأخير كاملاً، يستبدل كل نسخ JSON الفلاتر داخل البلووك (مع varint الطول)،
  // يعيد حساب CRC، ويلحق سجلاً جديداً نهاية ملف المخزن — يعمل حتى لو كان موضع القيمة أصغر.
  let file = null, bestMtime = -1, rec = null;
  for (const f of fs.readdirSync(dir).filter(f => /\.log$/i.test(f))) {
    const p = path.join(dir, f);
    let b;
    try { b = fs.readFileSync(p); } catch (_) { continue; }
    let r;
    try { r = findLastPresetRecord(b); } catch (_) { continue; }
    const mt = fs.statSync(p).mtimeMs;
    if (mt > bestMtime) { bestMtime = mt; file = f; rec = r; rec.buf = b; }
  }
  if (!file) throw new Error('لم يُعثر على مخزن الفلاتر الحالي.');

  // حدّد مواضع كل نسخ قيمة الفلاتر داخل هذا السجل
  const nd = Buffer.from('{"filterPresets"', 'latin1');
  const copies = [];
  let i = 0;
  const rel = rec.payload;
  while ((i = rel.indexOf(nd, i)) >= 0) {
    const mv = matchValueVarint(rel, i);
    if (mv) {
      const jlen = jsonEnd(rel, i) - i;
      if (jlen > 0 && mv.varStart >= 0 && i + jlen <= rel.length) copies.push({ varStart: mv.varStart, jsonStart: i, jsonEnd: i + jlen });
    }
    i++;
  }
  if (!copies.length) throw new Error('تعذّر تحديد مواضع قيمة الفلاتر داخل السجل.');

  const newJSON = Buffer.from(JSON.stringify(newValueObj), 'latin1');
  let head = Buffer.from(rel);
  head.writeBigUInt64LE(head.readBigUInt64LE(0) + 1n, 0);   // bump sequence
  // استبدال من الخلف لتجنّب إزاحة المواضع
  for (let k = copies.length - 1; k >= 0; k--) {
    const c = copies[k];
    head = Buffer.concat([head.subarray(0, c.varStart), encodeVarint(newJSON.length), newJSON, head.subarray(c.jsonEnd)]);
  }

  if (head.length > LOG_BLOCK - 7) throw new Error('البريسيت كبير جداً لسجل واحد (' + head.length + ' > ' + (LOG_BLOCK - 7) + ').');
  const typeAndData = Buffer.concat([Buffer.from([1]), head]);
  const header = Buffer.alloc(7);
  header.writeUInt32LE(crcMask(crc32c(typeAndData)), 0);
  header.writeUInt16LE(head.length, 4);
  header.writeUInt8(1, 6);                                     // type=FULL record
  const record = Buffer.concat([header, head]);

  const p = path.join(dir, file);
  const size = fs.statSync(p).size;
  const rem = size % LOG_BLOCK;
  if (rem) fs.appendFileSync(p, Buffer.alloc(LOG_BLOCK - rem)); // حشو لحدود البلووك كما يفعل LevelDB
  fs.appendFileSync(p, record);
  return { method: 'append', file, batchLen: head.length, seq: Number(head.readBigUInt64LE(0)), copies: copies.length };
}

// ---- control schema templates confirmed from the real NVIDIA store ----
const FILTER_TEMPLATES = {
  'Color.fx': {
    name: 'Color',
    range: { min: -1, max: 1, step: 0.02, uiStep: 2 },
    controls: [
      ['Tint Color', 0, 1, 0.01, 1, 20],
      ['Tint Intensity', 0, 1, 0.01, 1, 30],
      ['Temperature', -1, 1, 0.02, 2, 0],
      ['Vibrance', -1, 1, 0.02, 2, 0],
    ],
  },
  'Details.fx': {
    name: 'Details',
    controls: [
      ['Sharpen', 0, 1, 0.01, 1, 50],
      ['Clarity', -1, 1, 0.02, 2, 70],
      ['HDR Toning', -1, 1, 0.02, 2, 60],
      ['Bloom', 0, 1, 0.01, 1, 15],
    ],
  },
  'Adjustments.fx': {
    name: 'Brightness / Contrast',
    controls: [
      ['Exposure', -1, 1, 0.02, 2, 10],
      ['Contrast', -1, 1, 0.02, 2, 15],
      ['Highlights', -1, 1, 0.02, 2, 30],
      ['Shadows', -1, 1, 0.02, 2, -10],
      ['Gamma', -1, 1, 0.02, 2, 0],
    ],
  },
  'Vignette.fx': {
    name: 'Vignette',
    controls: [
      ['Intensity', 0, 1, 0.01, 1, 50],
    ],
  },
};

const NAME_TO_FX = { 'Color': 'Color.fx', 'Details': 'Details.fx', 'Brightness / Contrast': 'Adjustments.fx', 'Brightness/Contrast': 'Adjustments.fx', 'Brightness and Contrast': 'Adjustments.fx', 'Vignette': 'Vignette.fx' };

// ---- قوالب إضافية مكتشفة من مخزن NVIDIA (تتقبّل أي فلتر استخدمه أي مستخدم) ----
(function loadDiscovered() {
  try {
    if (!fs.existsSync(DISCOVERED_FILE)) return;
    const disc = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
    for (const f of disc) {
      if (!f || !f.id || !Array.isArray(f.controls) || !f.controls.length) continue;
      if (!FILTER_TEMPLATES[f.id]) {
        FILTER_TEMPLATES[f.id] = { name: f.name, controls: f.controls.map(c => [
          c.displayName, c.minValue ?? -1, c.maxValue ?? 1, c.stepSize ?? 0.01, c.uiStepSize ?? 2, c.defaultValue ?? c.currentUIValue ?? 0,
        ]) };
      }
      NAME_TO_FX[f.name] = f.id;
    }
  } catch (_) {}
})();

// preset schema file: {"preset_name": "...", "filters":[{"name":"Color","settings":{...}}, ...]}
// or {"filters_stack":[{"order":1,"name":"...","settings":{...}}, ...]}
// Order of the array = stack order (index 0 = top layer), like Photoshop layers.
function uiValsFromSchema(schema) {
  const list = [];
  if (Array.isArray(schema.filters_stack)) {
    list.push(...[...schema.filters_stack].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
  } else if (Array.isArray(schema.filters)) {
    list.push(...schema.filters);
  }
  const out = [];
  const seen = new Set();
  for (const f of list || []) {
    const fx = NAME_TO_FX[String(f.name).trim()];
    if (!fx || seen.has(fx)) continue;
    seen.add(fx);
    const tpl = FILTER_TEMPLATES[fx];
    const settings = f.settings || {};
    const ui = tpl.controls.map(([disp], i) =>
      settings[disp] == null ? tpl.controls[i][5] : settings[disp]);
    out.push([fx, ui]);
  }
  return out;
}

function fxIdBasename(idRaw) {
  if (!idRaw) return null;
  const base = String(idRaw).replace(/\\/g, '/').split('/').pop();
  return base && /\.fx$/i.test(base) ? base : null;
}

// يعطي فلتراً بُني مباشرة من البيانات الخام (controls) — لا يفترض قالباً معروفاً.
function buildFilterFromRaw(raw, idx) {
  const base = fxIdBasename(raw.id) || (String(raw.name || '').trim().toLowerCase().endsWith('.fx') ? String(raw.name).trim() : null);
  const id = base ? fxPath(base) : (raw.id || fxPath((String(raw.name || 'filter').trim() + '.fx')));
  const controls = (raw.controls || []).map((c, i) => ({
    controlType: c.controlType || 'slider', displayName: c.displayName,
    currentValueArray: c.currentValueArray ?? [c.currentValue ?? 0], id: i,
    dataType: c.dataType || 'float', dimension: c.dimension || 0, measureUnit: c.measureUnit || '%',
    minValue: c.minValue ?? -1, maxValue: c.maxValue ?? 1, stepSize: c.stepSize ?? 0.01,
    currentValue: c.currentValue ?? (Array.isArray(c.currentValueArray) ? c.currentValueArray[0] : 0),
    uiMinValue: c.uiMinValue ?? -100, uiMaxValue: c.uiMaxValue ?? 100, uiStepSize: c.uiStepSize ?? 1,
    currentUIValue: c.currentUIValue ?? ((c.currentValue ?? 0) * 100),
    defaultValue: c.defaultValue ?? c.currentUIValue ?? 0,
  }));
  return { id, name: raw.name || '', isSelected: idx === 0, stackIdx: idx, controls };
}

function schemaObjectList(schema) {
  if (Array.isArray(schema.filters_stack)) {
    return [...schema.filters_stack].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  if (Array.isArray(schema.filters)) return schema.filters;
  return [];
}

function filterPairsFromPreset(presetArg) {
  // returns [{id, ui}] أو [{raw, key}] — raw تعني فلتراً يمرر كما هو (بدون قالب)
  if (LIBRARY[presetArg]) {
    return Object.entries(LIBRARY[presetArg]).map(([id, ui]) => ({ id, ui, key: id }));
  }
  if (fs.existsSync(presetArg)) {
    const schema = JSON.parse(fs.readFileSync(presetArg, 'utf8'));
    const out = [];
    const seen = new Set();
    for (const f of schemaObjectList(schema)) {
      if (f && Array.isArray(f.controls) && f.controls.length) {
        const key = String(f.id || f.name || f.fx_id || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ raw: f, key });
      } else {
        if (!f || typeof f !== 'object') continue;
        const fx = NAME_TO_FX[String(f.name || '').trim()];
        if (!fx || seen.has(fx)) continue;
        seen.add(fx);
        const tpl = FILTER_TEMPLATES[fx];
        const settings = f.settings || {};
        const ui = tpl.controls.map(([disp], i) =>
          settings[disp] == null ? tpl.controls[i][5] : settings[disp]);
        out.push({ id: fx, ui, key: fx });
      }
    }
    return out;
  }
  return null;
}

function fxPath(name) {
  // Use the driverstore NvCamera path seen on this machine; keep it symbolic & overridable.
  const dd = path.basename('nv_dispi.inf_amd64_436833bbb0f00476');
  return 'C:\\Windows\\System32\\DriverStore\\FileRepository\\' + dd + '\\NvCamera\\' + name;
}

function uiToRaw(ui, min, max) {
  // raw spans [min,max] linearly onto ui [min*100, max*100]
  return Number((min + (ui / 100) * (max - min)).toFixed(6));
}

function buildFilter(id, uiValues, _, idx) {
  const tpl = FILTER_TEMPLATES[id];
  const controls = tpl.controls.map(([disp, min, max, step, uiStep, def], i) => {
    const ui = uiValues[i] ?? def;
    const raw = uiToRaw(ui, min, max);
    return {
      controlType: 'slider', displayName: disp, currentValueArray: [raw], id: i,
      dataType: 'float', dimension: 0, measureUnit: '%', minValue: min, maxValue: max,
      stepSize: step, currentValue: raw, uiMinValue: min * 100, uiMaxValue: max * 100,
      uiStepSize: uiStep, currentUIValue: ui, defaultValue: def,
    };
  });
  return {
    id: fxPath(id), name: tpl.name, isSelected: idx === 0, stackIdx: idx,
    controls, isPPEFilter: false, isExpanded: false, errorCodes: [], isVisible: false,
  };
}

// Our library presets map: filter -> array of UI values in template order
const LIBRARY = {
  'vibrant-anime': {
    'Color.fx': [0, 0, 10, 25], 'Details.fx': [25, 20, 12, 0], 'Adjustments.fx': [5, 10, -5, 0, 0],
  },
  'soft-cinematic': {
    'Color.fx': [0, 0, 5, 12], 'Details.fx': [15, 35, 15, 8], 'Adjustments.fx': [0, 8, -5, 10, 0],
  },
  'crisp-realistic': {
    'Color.fx': [35, 40, 0, 0], 'Details.fx': [50, 0, 0, 0], 'Adjustments.fx': [0, 5, -10, 9, 0],
  },
};

function bakeSlot(presetArgs) {
  // presetArgs: library names or paths to preset schema JSON files; first match wins per filter
  // Stack order = order of first appearance across presets (top layer first) — do NOT re-sort.
  const seen = new Set();
  const ordered = [];
  for (const arg of presetArgs) {
    const pairs = filterPairsFromPreset(arg);
    if (!pairs) continue;
    for (const p of pairs) {
      if (p && !seen.has(p.key)) { seen.add(p.key); ordered.push(p); }
    }
  }
  if (!ordered.length) return [];
  return ordered.map((p, idx) => (p.raw ? buildFilterFromRaw(p.raw, idx)
                                       : buildFilter(p.id, p.ui, presetArgs[0], idx)));
}

function stackForSlot(id, names) {
  const filters = bakeSlot(names);
  if (!filters.length) throw new Error('no known preset names given');
  return {
    filterStack: {
      filters, selectedFilterCount: filters.length,
      upButtonDisabled: false, downButtonDisabled: true,
    },
    id, altText: String(id),
  };
}

// ---- live write: splice a rebuilt value into the store journal (same byte length) ----
function findLastBlobBytes(buf, needle = '{"filterPresets"') {
  const nd = Buffer.from(needle, 'latin1');
  let last = -1, i = 0;
  while ((i = buf.indexOf(nd, i)) >= 0) { last = i; i++; }
  if (last < 0) return null;
  const start = last;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = start; j < buf.length; j++) {
    const ch = buf[j];
    if (inStr) { if (esc) esc = false; else if (ch === 0x5c) esc = true; else if (ch === 0x22) inStr = false; }
    else { if (ch === 0x22) inStr = true; else if (ch === 0x7b) depth++; else if (ch === 0x7d) { depth--; if (depth === 0) { end = j + 1; break; } } }
  }
  return end < 0 ? null : { start, end, blob: buf.subarray(start, end) };
}

function spliceValue(dir, newValueObj) {
  // find the freshest file holding filter JSON; return the replace report
  const names = fs.readdirSync(dir).filter(f => /\.(log|ldb)$/i.test(f));
  const cands = [];
  for (const f of names) {
    const p = path.join(dir, f);
    let b;
    try { b = fs.readFileSync(p); } catch (_) { continue; }
    const found = findLastBlobBytes(b);
    if (found) cands.push({ file: f, buf: b, mtime: fs.statSync(p).mtimeMs, ...found });
  }
  if (!cands.length) throw new Error('لم يُعثر على مخزن الفلاتر الحالي.');
  cands.sort((a, b) => b.mtime - a.mtime || b.start - a.start);
  const best = cands[0];
  const newS = JSON.stringify(newValueObj);
  if (newS.length > best.blob.length) {
    const err = new Error('الخانة المتاحة أصغر من القيمة الجديدة (' + newS.length + ' > ' + best.blob.length + '). أغلق NVIDIA App ثم أعد المحاولة.');
    err.code = 'TOO_LONG';
    throw err;
  }
  const pad = ' '.repeat(best.blob.length - newS.length);
  const next = Buffer.alloc(best.blob.length);
  Buffer.from(newS, 'latin1').copy(next, 0);
  if (pad.length) Buffer.from(pad, 'latin1').copy(next, newS.length);
  const prefix = best.buf.subarray(0, best.start);
  const suffix = best.buf.subarray(best.end);
  fs.writeFileSync(path.join(dir, best.file), Buffer.concat([prefix, next, suffix]));
  return { file: best.file, blobLen: best.blob.length, newLen: newS.length, padLen: pad.length };
}

const leanFilter = (f) => ({ id: f.id, name: f.name, isSelected: f.isSelected, stackIdx: f.stackIdx, controls: f.controls });

function leanBundle(fp, exe, slot, filters) {
  // NVIDIA regenerates UI-only fields (isExpanded/errorCodes/isVisible/isPPEFilter);
  // dropping them keeps the bundle short so it always fits the existing value slot.
  const slots = [];
  const info = fp.filterPresets[exe].modsSlotsInfo;
  for (let s = 0; s <= 3; s++) {
    const cur = (info.slots || [])[s];
    if (s === slot) {
      slots.push({ filterStack: { filters: filters.map(leanFilter), selectedFilterCount: filters.length, upButtonDisabled: false, downButtonDisabled: true }, id: s, altText: String(s) });
    } else {
      const fs0 = (cur && cur.filterStack || { filters: [] });
      slots.push({ filterStack: { filters: (fs0.filters || []).map(leanFilter), selectedFilterCount: fs0.selectedFilterCount || 0, upButtonDisabled: fs0.upButtonDisabled !== false, downButtonDisabled: fs0.downButtonDisabled !== false }, id: s, altText: cur && cur.altText != null ? cur.altText : String(s) });
    }
  }
  return { filterPresets: { [exe]: { anselSlotsInfo: fp.filterPresets[exe].anselSlotsInfo, modsSlotsInfo: { lastSlotIdx: info.lastSlotIdx == null ? 3 : info.lastSlotIdx, slots } } } };
}

function genBundle(exePath, slotPresets) {
  // slotPresets: {1:[names],2:[names],3:[names]}
  const emptyStack = { filters: [], selectedFilterCount: 0, upButtonDisabled: true, downButtonDisabled: true };
  const slots = [{ filterStack: emptyStack, id: 0, altText: 'settings.None' }];
  for (let s = 1; s <= 3; s++) {
    const names = slotPresets[s] || [];
    slots.push(names.length ? stackForSlot(s, names) : { filterStack: { ...emptyStack, upButtonDisabled: true }, id: s, altText: String(s) });
  }
  return {
    filterPresets: {
      [exePath]: {
        anselSlotsInfo: { lastSlotIdx: 1, slots: [slots[0], { ...emptyStack, id: 1, altText: '1' }] },
        modsSlotsInfo: { lastSlotIdx: 3, slots },
      },
    },
  };
}

// ---- commands ----
const [,, cmd, ...args] = process.argv;
(async () => {
  switch (cmd) {
    case 'slots': {
      const fp = currentFilterPresets();
      if (!fp) { console.log('لم يتم العثور على بيانات فلاتر (افتح Freestyle مرة ثم أعد المحاولة).'); return; }
      const exes = Object.keys(fp.filterPresets || {});
      console.log('اللعبة المخزنة:', exes.join(', '));
      for (const exe of exes) {
        const m = fp.filterPresets[exe];
        console.log('\n== ' + exe + ' ==');
        for (const kind of ['modsSlotsInfo', 'anselSlotsInfo']) {
          const info = m[kind];
          if (!info) continue;
          console.log('_' + kind + '_ lastSlotIdx=' + info.lastSlotIdx);
          for (const slot of info.slots || []) {
            const fsList = ((slot.filterStack || {}).filters || []).map(f => {
              const ctl = (f.controls || []).map(c => c.displayName + '=' + c.currentUIValue).join(', ');
              return f.name + '{' + ctl + '}';
            });
            console.log('  slot#' + slot.id + ' (' + slot.altText + '): ' + (fsList.length ? fsList.join(' + ') : '(فارغ)'));
          }
        }
      }
      break;
    }
    case 'export': {
      const name = args[0] || 'slots-' + new Date().toISOString().slice(0, 10);
      const fp = currentFilterPresets();
      if (!fp) { console.log('لا توجد بيانات للتصدير.'); return; }
      fs.mkdirSync(COLLECTED, { recursive: true });
      const file = path.join(COLLECTED, name + '.nvpreset.json');
      fs.writeFileSync(file, JSON.stringify(fp, null, 2));
      console.log('تم تصدير فلاتر NVIDIA الحالية إلى:');
      console.log(file);
      break;
    }
    case 'import': {
      // import <1|2|3> <preset[,preset...]>  (أو ملف تصدير .nvpreset.json)
      const slot = Number(args[0]);
      const names = (args[1] || '').split(',').filter(Boolean);
      if (!slot || slot < 1 || slot > 3 || !names.length) {
        console.log('الاستخدام: import <1|2|3> <preset[,preset...]>');
        console.log('المتاح: vibrant-anime, soft-cinematic, crisp-realistic، أو مسار ملف JSON');
        return;
      }
      if (isStoreBusy()) {
        console.log('⚠ NVIDIA App/Overlay يعمل — الكتابة قد لا تُطبَّق فوراً.');
        console.log('  لإنجاح أفضل: أغلق Overlay ثم أعد التطبيق.');
      }
      const rawStack = stackFromExportFile(names[0], slot);
      fs.mkdirSync(BACKUPS, { recursive: true });
      const label = 'auto-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      fs.mkdirSync(path.join(BACKUPS, label), { recursive: true });
      try {
        fs.cpSync(OVERLAY_DB, path.join(BACKUPS, label, 'Overlay_' + path.basename(OVERLAY_DB)), { recursive: true, force: true });
        const dry = path.join(os.tmpdir(), 'nv-splice-dry');
        fs.rmSync(dry, { recursive: true, force: true });
        fs.mkdirSync(dry, { recursive: true });
        fs.cpSync(OVERLAY_DB, path.join(dry, 'store'), { recursive: true, force: true });
      } catch (e) {
        console.log('أغلق NVIDIA App أولاً (المخزن مشغول).');
        console.log('2) أعد تشغيل: import ' + args.join(' '));
        console.log('3) ثم افتح اللعبة واختر الخانة ' + slot + ' عبر Alt+F3.');
        return;
      }
      const fp = currentFilterPresets();
      if (!fp) { console.log('لا توجد بيانات حية لدمجها.'); return; }
      const exes = Object.keys(fp.filterPresets || {});
      if (!exes.length) { console.log('لا توجد لعبة مسجلة.'); return; }
      const exe = exes[0];
      const filters = rawStack ? rawStack.map(leanFilter)
                               : bakeSlot(names);
      if (!filters.length) { console.log('لا يوجد بريسيت بهذا الاسم أو الملف غير صالح.'); return; }
      const target = leanBundle(fp, exe, slot, filters);
      const dry = path.join(os.tmpdir(), 'nv-splice-dry');
      let rep, writeMethod;
      try {
        rep = spliceValue(path.join(dry, 'store'), target);
        writeMethod = 'inplace';
      } catch (e) {
        if (e.code !== 'TOO_LONG') {
          console.log('لا يمكن تطبيق الاستيراد الآن:');
          console.log('  ' + e.message);
          console.log('(خُزِنَت نسخة أمان قبل أي تعديل: ' + label + ')');
          return;
        }
        try {
          rep = appendValue(path.join(dry, 'store'), target);   // السجل الحالي أصغر من القيمة
          writeMethod = 'append';
        } catch (e2) {
          console.log('لا يمكن تطبيق الاستيراد الآن (السجل الحالي أصغر من القيمة):');
          console.log('  ' + e2.message);
          console.log('(خُزِنَت نسخة أمان قبل أي تعديل: ' + label + ')');
          return;
        }
      }
      const ver = readStore(path.join(dry, 'store'));
      const check = findJsonBlobs(ver);
      const last = check[check.length - 1];
      const got = last && last.filterPresets && last.filterPresets[exe] && last.filterPresets[exe].modsSlotsInfo && last.filterPresets[exe].modsSlotsInfo.slots[slot];
      const ok = got && got.filterStack.filters.length === filters.length;
      if (!ok) { console.log('فشل التحقق من النسخة الجديدة (لا شيء تغيّر).'); return; }
      let rep2;
      try {
        rep2 = writeMethod === 'append' ? appendValue(OVERLAY_DB, target) : spliceValue(OVERLAY_DB, target);
      } catch (e) {
        if (e.code === 'TOO_LONG') {
          try { rep2 = appendValue(OVERLAY_DB, target); }
          catch (e3) {
            console.log('تعذّر الكتابة في المخزن: ' + e3.message);
            console.log('(آخر نسخة آمنة: ' + label + ' — استعدها بـ: restore ' + label + ')');
            return;
          }
        } else {
          console.log('تعذّر الكتابة في المخزن: أغلق NVIDIA App ثم أعد المحاولة.');
          console.log('(آخر نسخة آمنة: ' + label + ' — استعدها بـ: restore ' + label + ')');
          return;
        }
      }
      console.log('تم استيراد البريست إلى الخانة ' + slot + ' (' + (writeMethod === 'append' ? 'إلحاق سجل جديد' : 'كتابة مكانية') + ') من ' + rep2.file + '.');
      console.log('نسخة أمان تلقائية قبل التطبيق: ' + label);
      console.log('✔ التحقق من الكتابة — الخانة ' + slot + ' أصبحت:');
      console.log('   ' + slotReadout(currentFilterPresets(), slot));
      console.log('افتح اللعبة واختر الخانة ' + slot + ' (Alt+F3) لرؤية النتيجة.');
      break;
    }
    case 'bake': {
      const slot = Number(args[0]);
      const names = (args[1] || '').split(',').filter(Boolean);
      if (!slot || slot < 1 || slot > 3 || !names.length) {
        console.log('الاستخدام: bake <1|2|3> <preset[,preset...]>');
        console.log('المتاح: vibrant-anime, soft-cinematic, crisp-realistic، أو مسار ملف JSON بـ صيغة المقترحة');
        return;
      }
      const exePath = 'C:\\Program Files\\HoYoPlay\\games\\Genshin Impact game\\GenshinImpact.exe';
      const bundle = genBundle(exePath, { [slot]: names });
      fs.mkdirSync(COLLECTED, { recursive: true });
      const file = path.join(COLLECTED, 'slot' + slot + '-baked.nvpreset.json');
      fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
      console.log('تم توليد بريسيت NVIDIA بصيغته الداخلية:');
      console.log(file);
      break;
    }
    case 'backup': {
      const label = args[0] || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const dst = path.join(BACKUPS, label);
      fs.mkdirSync(dst, { recursive: true });
      for (const [name, src] of [['Overlay', OVERLAY_DB], ['App', APP_DB]]) {
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.join(dst, name + '_' + path.basename(src)), { recursive: true, force: true });
        }
      }
      console.log('النسخة الاحتياطية في:');
      console.log(dst);
      break;
    }
    case 'restore': {
      const label = args[0];
      if (!label) { console.log('الاستخدام: restore <label>'); return; }
      const src = path.join(BACKUPS, label);
      if (!fs.existsSync(src)) { console.log('لا يوجد نسخة بهذا الاسم.'); return; }
      for (const [name, dst] of [['Overlay', OVERLAY_DB], ['App', APP_DB]]) {
        const s = path.join(src, name + '_' + path.basename(dst));
        if (fs.existsSync(s)) {
          if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
          fs.cpSync(s, dst, { recursive: true, force: true });
          console.log('تمت الاستعادة:', dst);
        }
      }
      console.log('أغلق NVIDIA App واللعبة قبل الاستعادة، ثم أعد فتحها. الاسم المستخدم:', label);
      break;
    }
    case 'filters': {
      // filters — اكتشاف كل أنواع الفلاتر + مقابضها من المخزن وحفظها قوالب
      const fp = currentFilterPresets();
      if (!fp) { console.log('لا توجد بيانات فلاتر (افتح Freestyle مرة ثم أعد المحاولة).'); return; }
      const seen = new Map();
      for (const exe of Object.keys(fp.filterPresets || {})) {
        const m = fp.filterPresets[exe];
        for (const kind of ['modsSlotsInfo', 'anselSlotsInfo']) {
          const info = m[kind];
          if (!info) continue;
          for (const s of info.slots || []) {
            for (const f of (((s || {}).filterStack || {}).filters) || []) {
              const id = fxIdBasename(f.id) || String(f.name || 'unknown');
              if (seen.has(id)) continue;
              seen.set(id, {
                id,
                name: f.name,
                controls: (f.controls || []).map(c => ({
                  displayName: c.displayName, currentUIValue: c.currentUIValue, defaultValue: c.defaultValue,
                  minValue: c.minValue, maxValue: c.maxValue, stepSize: c.stepSize, uiStepSize: c.uiStepSize,
                  uiMinValue: c.uiMinValue, uiMaxValue: c.uiMaxValue,
                })),
              });
            }
          }
        }
      }
      const arr = [...seen.values()];
      fs.mkdirSync(TOOL_DIR, { recursive: true });
      fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(arr, null, 2));
      console.log('الفلاتر المكتشفة في المخزن (' + arr.length + '):');
      for (const f of arr) {
        console.log('  ' + f.id + '  —  ' + f.name + '  —  ' + (f.controls || []).map(c => c.displayName).join(', '));
      }
      console.log('\nحُفظت القوالب في: ' + DISCOVERED_FILE);
      break;
    }
    case 'json': {
      // json <outfile>  — write current filterPresets JSON to a file (for the GUI)
      const out = args[0];
      const fp = currentFilterPresets();
      if (!fp) { if (out) fs.writeFileSync(out, '{}', 'utf8'); else console.log('{}'); return; }
      if (out) fs.writeFileSync(out, JSON.stringify(fp, null, 2), 'utf8');
      else process.stdout.write(JSON.stringify(fp));
      break;
    }
    default:
      console.log('NV Preset Manager — أوامر:');
      console.log('  slots                 عرض الخانات المخزنة بالفلاتر');
      console.log('  export <name>         تصدير فلاتر NVIDIA الحالية كملف .nvpreset.json');
      console.log('  import <1|2|3> <presets> تطبيق بريسيت على خانة مباشرة (أغلق NVIDIA App أولاً)');
      console.log('  bake <1|2|3> <presets> توليد بريسيت بصيغة NVIDIA الداخلية من المكتبة');
      console.log('  backup [label]        نسخة احتياطية كاملة لمخزن NVIDIA');
      console.log('  restore <label>       استعادة نسخة محفوظة');
  }
})();