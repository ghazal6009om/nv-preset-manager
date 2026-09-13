# -*- coding: utf-8 -*-
"""app_logic.py — منطق التحكم في البروفايلات (استيراد/تصدير/تطبيق)"""
import os
import json
import time
import subprocess

from tkinter import filedialog, messagebox

ROOT = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(ROOT, "tool", "nv.mjs")
DATA_FILE = os.path.join(ROOT, "presets_data.json")
TMP_SCHEMA = os.path.join(ROOT, "presets", "creator-now.json")

ACCENTS = {1: "#38bdf8", 2: "#a855f7", 3: "#22c55e"}


def run_backend(*args):
    try:
        p = subprocess.run(["node", TOOL, *args], capture_output=True, timeout=90)
        return (p.stdout.decode("utf-8", errors="replace").strip()
                or p.stderr.decode("utf-8", errors="replace").strip())
    except Exception as e:  # noqa: BLE001
        return f"خطأ في تشغيل الأداة: {e}"


class NVFilterController:
    def __init__(self, data_file=None):
        self.data_file = data_file or DATA_FILE
        self.data = self.load_data()
        self.current_profile = self.data.get("active_profile", 1)

    # ---------------- تحميل البيانات ----------------
    def load_data(self):
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:  # noqa: BLE001
                pass
        return self.sync_from_nvidia()

    def _read_store(self):
        tmp = os.path.join(os.environ.get("TEMP", "."), "nv-manager-store.json")
        run_backend("json", tmp)
        try:
            with open(tmp, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:  # noqa: BLE001
            return None

    def _store_filters(self, slot):
        fp = self._read_store()
        if not fp or not fp.get("filterPresets"):
            return []
        exe = next(iter(fp["filterPresets"].keys()))
        info = fp["filterPresets"][exe].get("modsSlotsInfo") or {}
        slots = info.get("slots") or []
        for s in slots:
            if s.get("id") == slot:
                out = []
                for f in s.get("filterStack", {}).get("filters", []):
                    settings = {c.get("displayName"): c.get("currentUIValue")
                                for c in f.get("controls", [])}
                    out.append({"name": f.get("name"), "settings": settings})
                return out
        return []

    def sync_from_nvidia(self):
        """بناء البيانات من مخزن NVIDIA الحالي."""
        profiles = {}
        for i in (1, 2, 3):
            filters = self._store_filters(i)
            profiles[str(i)] = {
                "name": f"بروفايل {i}",
                "accent": ACCENTS.get(i, "#38bdf8"),
                "filters": filters,
            }
        data = {"active_profile": 1, "profiles": profiles}
        self._write(data)
        return data

    def _write(self, data):
        try:
            with open(self.data_file, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass

    def save_data(self):
        self.data["active_profile"] = self.current_profile
        self._write(self.data)

    # ---------------- الوصول للبروفايلات ----------------
    def select_profile(self, profile_id):
        self.current_profile = int(profile_id)
        self.data["active_profile"] = self.current_profile
        return self.data["profiles"].get(str(profile_id), {"name": "", "filters": []})

    def active_profile(self):
        return self.data["profiles"].get(str(self.current_profile),
                                         {"name": "", "filters": []})

    def _schema_file_for(self, profile_id=None):
        p = self.data["profiles"].get(str(profile_id or self.current_profile), {})
        os.makedirs(os.path.dirname(TMP_SCHEMA), exist_ok=True)
        with open(TMP_SCHEMA, "w", encoding="utf-8") as fh:
            json.dump({"preset_name": p.get("name", "preset"),
                       "filters": p.get("filters", [])}, fh, ensure_ascii=False, indent=2)
        return TMP_SCHEMA

    # ---------------- استيراد / تصدير ----------------
    def import_profile(self, path=None, slot=None):
        """تحميل بريسيت إلى الخانة (النشطة افتراضياً) وتحديث العرض فوراً."""
        target = int(slot or self.current_profile)
        if path is None:
            path = filedialog.askopenfilename(
                title=f"استيراد بريسيت للخانة {target}",
                filetypes=[("JSON", "*.json")])
        if not path:
            return None
        with open(path, encoding="utf-8") as fh:
            imported = json.load(fh)
        profile = self.data["profiles"].setdefault(str(target),
                                                    {"name": "",
                                                     "accent": ACCENTS.get(target),
                                                     "filters": []})
        profile["name"] = imported.get("preset_name", imported.get("name", profile.get("name", f"بروفايل {target}")))
        filters = imported.get("filters")
        stack = imported.get("filters_stack")
        if isinstance(stack, list):
            filters = sorted(stack, key=lambda f: f.get("order", 0))
        if not isinstance(filters, list):
            filters = []
        profile["filters"] = filters
        self.save_data()
        if self.current_profile != target:
            self.select_profile(target)
        return profile

    def export_profile(self, profile_id=None, path=None):
        """تصدير إعدادات الخانة الحالية."""
        pid = int(profile_id or self.current_profile)
        profile = self.data["profiles"].get(str(pid))
        if not profile or not profile.get("filters"):
            messagebox.showwarning("تنبيه", "الخانة المحددة فارغة أو لا توجد بيانات!")
            return None
        if path is None:
            path = filedialog.asksaveasfilename(defaultextension=".json",
                                                filetypes=[("JSON", "*.json")],
                                                title=f"تصدير بريسيت الخانة {pid}")
        if not path:
            return None
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(profile, fh, ensure_ascii=False, indent=2)
        return path

    # ---------------- التطبيق على NVIDIA ----------------
    def apply_to_nvidia(self, profile_id=None):
        """كتابة البريسيت في مخزن NVIDIA للخانة المحددة (قبل فتح اللعبة)."""
        pid = int(profile_id or self.current_profile)
        schema = self._schema_file_for(pid)
        res = run_backend("import", str(pid), schema)
        return res