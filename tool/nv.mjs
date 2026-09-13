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

const LOCAL = process.env.LOCALAPPDATA;
const OVERLAY_DB = path.join(LOCAL, 'NVIDIA Corporation', 'NVIDIA Overlay', 'CefCache', 'Default', 'IndexedDB', 'https_nvfile_0.indexeddb.leveldb');
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

// preset schema file: {"preset_name": "...", "filters":[{"name":"Color","settings":{"Temperature":-15,...}}]}
function uiValsFromSchema(schema) {
  const order = ['Color.fx', 'Details.fx', 'Adjustments.fx', 'Vignette.fx'];
  const out = [];
  const byName = Object.create(null);
  for (const f of schema.filters || []) byName[String(f.name).trim()] = f.settings || {};
  for (const fid of order) {
    const tpl = FILTER_TEMPLATES[fid];
    const key = Object.keys(NAME_TO_FX).find(k => NAME_TO_FX[k] === fid && byName[k] != null);
    if (!key) continue;
    const ui = tpl.controls.map(([disp], i) => {
      const v = byName[key][disp];
      return v == null ? tpl.controls[i][5] : v;
    });
    out.push([fid, ui]);
  }
  return out;
}

function filterPairsFromPreset(presetArg) {
  // returns [{id, uiValues}] ready for buildFilter
  if (LIBRARY[presetArg]) {
    return Object.entries(LIBRARY[presetArg]).map(([id, ui]) => ({ id, ui }));
  }
  if (fs.existsSync(presetArg)) {
    const schema = JSON.parse(fs.readFileSync(presetArg, 'utf8'));
    return uiValsFromSchema(schema).map(([id, ui]) => ({ id, ui }));
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
  const merged = new Map(); // id -> ui
  for (const arg of presetArgs) {
    const pairs = filterPairsFromPreset(arg);
    if (!pairs) continue;
    for (const { id, ui } of pairs) if (!merged.has(id)) merged.set(id, ui);
  }
  const order = ['Color.fx', 'Details.fx', 'Adjustments.fx', 'Vignette.fx'].filter(id => merged.has(id));
  return order.map((id, i) => buildFilter(id, merged.get(id), presetArgs[0], i));
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

function leanBundle(fp, exe, slot, filters) {
  // NVIDIA regenerates UI-only fields (isExpanded/errorCodes/isVisible/isPPEFilter);
  // dropping them keeps the bundle short so it always fits the existing value slot.
  const lean = (f) => ({ id: f.id, name: f.name, isSelected: f.isSelected, stackIdx: f.stackIdx, controls: f.controls });
  const slots = [];
  const info = fp.filterPresets[exe].modsSlotsInfo;
  for (let s = 0; s <= 3; s++) {
    const cur = (info.slots || [])[s];
    if (s === slot) {
      slots.push({ filterStack: { filters: filters.map(lean), selectedFilterCount: filters.length, upButtonDisabled: false, downButtonDisabled: true }, id: s, altText: String(s) });
    } else {
      const fs0 = (cur && cur.filterStack || { filters: [] });
      slots.push({ filterStack: { filters: (fs0.filters || []).map(lean), selectedFilterCount: fs0.selectedFilterCount || 0, upButtonDisabled: fs0.upButtonDisabled !== false, downButtonDisabled: fs0.downButtonDisabled !== false }, id: s, altText: cur && cur.altText != null ? cur.altText : String(s) });
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
      // import <1|2|3> <preset[,preset...]>
      const slot = Number(args[0]);
      const names = (args[1] || '').split(',').filter(Boolean);
      if (!slot || slot < 1 || slot > 3 || !names.length) {
        console.log('الاستخدام: import <1|2|3> <preset[,preset...]>');
        console.log('المتاح: vibrant-anime, soft-cinematic, crisp-realistic');
        return;
      }
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
      const filters = bakeSlot(names);
      if (!filters.length) { console.log('لا يوجد بريسيت بهذا الاسم أو الملف غير صالح.'); return; }
      const target = leanBundle(fp, exe, slot, filters);
      const dry = path.join(os.tmpdir(), 'nv-splice-dry');
      let rep;
      try {
        rep = spliceValue(path.join(dry, 'store'), target);
      } catch (e) {
        console.log('لا يمكن تطبيق الاستيراد الآن:');
        console.log('  ' + (e.code === 'TOO_LONG' ? e.message : 'أغلق NVIDIA App واللعبة ثم أعد المحاولة.'));
        console.log('(خُزِنَت نسخة أمان قبل أي تعديل: ' + label + ')');
        return;
      }
      const ver = readStore(path.join(dry, 'store'));
      const check = findJsonBlobs(ver);
      const last = check[check.length - 1];
      const got = last && last.filterPresets && last.filterPresets[exe] && last.filterPresets[exe].modsSlotsInfo && last.filterPresets[exe].modsSlotsInfo.slots[slot];
      const ok = got && got.filterStack.filters.length === filters.length;
      if (!ok) { console.log('فشل التحقق من النسخة الجديدة (لا شيء تغيّر).'); return; }
      let rep2;
      try {
        rep2 = spliceValue(OVERLAY_DB, target);
      } catch (e) {
        if (e.code === 'TOO_LONG') console.log(e.message);
        else console.log('تعذّر الكتابة في المخزن: أغلق NVIDIA App ثم أعد المحاولة.');
        console.log('(آخر نسخة آمنة: ' + label + ' — استعدها بـ: restore ' + label + ')');
        return;
      }
      console.log('تم استيراد البريست إلى الخانة ' + slot + ' من الملف ' + rep2.file + '.');
      console.log('نسخة أمان تلقائية قبل التطبيق: ' + label);
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