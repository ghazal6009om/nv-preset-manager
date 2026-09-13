# -*- coding: utf-8 -*-
"""NV Preset Manager - modern GUI (CustomTkinter)"""
import os
import sys
import json
import glob
import time
import subprocess
import threading
from tkinter import messagebox, filedialog

import customtkinter as ctk

APP = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(APP, "tool", "nv.mjs")
PRESETS_DIR = os.path.join(APP, "presets", "library")
BACKUPS_DIR = os.path.join(APP, "backups")
NODE = "node"

# filter template (display name, min ui, max ui, ui step, default)
FILTERS = [
    ("Color", [
        ("Tint Color", 0, 100, 1, 20),
        ("Tint Intensity", 0, 100, 1, 30),
        ("Temperature", -100, 100, 2, 0),
        ("Vibrance", -100, 100, 2, 0),
    ]),
    ("Details", [
        ("Sharpen", 0, 100, 1, 50),
        ("Clarity", -100, 100, 2, 70),
        ("HDR Toning", -100, 100, 2, 60),
        ("Bloom", 0, 100, 1, 15),
    ]),
    ("Brightness / Contrast", [
        ("Exposure", -100, 100, 2, 10),
        ("Contrast", -100, 100, 2, 15),
        ("Highlights", -100, 100, 2, 30),
        ("Shadows", -100, 100, 2, -10),
        ("Gamma", -100, 100, 2, 0),
    ]),
    ("Vignette", [
        ("Intensity", 0, 100, 1, 50),
    ]),
]


def run_backend(*args):
    """Run the node tool and return its text output (utf-8)."""
    try:
        p = subprocess.run([NODE, TOOL, *args], capture_output=True, timeout=90)
        out = p.stdout.decode("utf-8", errors="replace").strip()
        err = p.stderr.decode("utf-8", errors="replace").strip()
        return out if out else err
    except Exception as e:  # noqa: BLE001
        return f"خطأ في تشغيل الأداة: {e}"


class Card(ctk.CTkFrame):
    def __init__(self, master, preset, preset_path, slot_combo, status_cb, **kw):
        super().__init__(master, corner_radius=14, border_width=1, border_color="#2b3542", **kw)
        accent = preset.get("accent", "#3b82f6")
        header = ctk.CTkFrame(self, fg_color=accent, corner_radius=12, height=54)
        header.pack(fill="x", padx=2, pady=(2, 8))
        header.pack_propagate(False)
        title = ctk.CTkLabel(header, text=preset.get("preset_name", "بريست"),
                              font=ctk.CTkFont(size=17, weight="bold"), text_color="#ffffff")
        title.pack(side="left", padx=14)
        right = ctk.CTkLabel(header, text="NVIDIA Freestyle", font=ctk.CTkFont(size=11), text_color="#e2e8f0")
        right.pack(side="right", padx=12)

        desc = ctk.CTkLabel(self, text=preset.get("description", ""),
                            text_color="#94a3b8", wraplength=430, justify="left")
        desc.pack(anchor="w", padx=14)

        chips = "  ".join(f["name"] for f in preset.get("filters", []))
        if chips:
            fl = ctk.CTkLabel(self, text="الفلاتر: " + chips, text_color="#64748b", font=ctk.CTkFont(size=11))
            fl.pack(anchor="w", padx=14, pady=(4, 0))

        def apply_():
            status_cb("جارٍ التطبيق... أغلق NVIDIA App إذا طُلب ذلك")
            res = run_backend("import", slot_combo.get(), preset_path)
            status_cb("تم التطبيق")
            messagebox.showinfo("استيراد", res)

        self._apply_btn = ctk.CTkButton(self, text="تطبيق على الخانة 1",
                                        fg_color=accent, hover_color=accent,
                                        command=apply_)
        self._apply_btn.pack(anchor="e", padx=14, pady=(6, 12))
        self._slot_combo = slot_combo

    def refresh_label(self):
        self._apply_btn.configure(text=f"تطبيق على الخانة {self._slot_combo.get()}")


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("NV Preset Manager")
        self.geometry("960x680")
        self.minsize(860, 620)
        ctk.set_appearance_mode("Dark")
        ctk.set_default_color_theme("blue")

        self.current_view = None
        self._build_sidebar()
        self._content = ctk.CTkFrame(self, fg_color="transparent")
        self._content.pack(side="right", fill="both", expand=True, padx=(0, 14), pady=(6, 14))
        self._build_header()

        self.show_library()
        self.update_game_status()

    # ---------------- layout ----------------
    def _build_sidebar(self):
        sb = ctk.CTkFrame(self, width=215, corner_radius=0, fg_color="#131a24")
        sb.pack(side="left", fill="y")
        sb.pack_propagate(False)

        logo = ctk.CTkFrame(sb, fg_color="#1e293b", corner_radius=14)
        logo.pack(padx=14, pady=(16, 8), fill="x")
        ctk.CTkLabel(logo, text="NV", font=ctk.CTkFont(size=11, weight="bold"),
                     text_color="#38bdf8").pack(pady=(10, 0))
        ctk.CTkLabel(logo, text="Preset Manager", font=ctk.CTkFont(size=20, weight="bold"),
                     text_color="#ffffff").pack(pady=(0, 6))

        self._nav = [
            ("🏷️  البريسيتات", self.show_library, "#3b82f6"),
            ("🛠️  منشئ بريسيت", self.show_creator, "#22d3ee"),
            ("🎮  الألعاب", self.show_games, "#a855f7"),
            ("💾  نسخ واستعادة", self.show_backup, "#f59e0b"),
        ]
        self._nav_btns = []
        for text, cmd, color in self._nav:
            b = ctk.CTkButton(sb, text=text, anchor="w", height=40, corner_radius=10,
                              fg_color="transparent", hover_color="#1e293b",
                              text_color="#cbd5e1", command=cmd)
            b.pack(fill="x", padx=10, pady=4)
            self._nav_btns.append(b)

        ctk.CTkLabel(sb, text="مصدر البيانات: مخزن NVIDIA الداخلي",
                     text_color="#475569", font=ctk.CTkFont(size=10)).pack(side="bottom", pady=12)

    def _build_header(self):
        hd = ctk.CTkFrame(self._content, corner_radius=12, fg_color="#1e293b", height=56)
        hd.pack(fill="x", pady=(0, 10))
        hd.pack_propagate(False)

        self._game_lbl = ctk.CTkLabel(hd, text="جارٍ فحص اللعبة...", font=ctk.CTkFont(size=13, weight="bold"),
                                      text_color="#e2e8f0")
        self._game_lbl.pack(side="left", padx=14)

        ctk.CTkLabel(hd, text="الخانة:", text_color="#94a3b8").pack(side="left", padx=(14, 4))
        self._slot_combo = ctk.CTkComboBox(hd, values=["1", "2", "3"], width=64, state="readonly", justify="center")
        self._slot_combo.set("1")
        self._slot_combo.pack(side="left")

        ctk.CTkButton(hd, text="تحديث", width=72, height=30, fg_color="#334155",
                      hover_color="#475569", command=self.refresh_all).pack(side="right", padx=10)

        self._status = ctk.CTkLabel(hd, text="جاهز", text_color="#94a3b8", font=ctk.CTkFont(size=11))
        self._status.pack(side="right", padx=8)

    def _set_status(self, text):
        self._status.configure(text=text[:80])
        self.update_idletasks()

    def _clear(self):
        for w in self._content.winfo_children()[1:]:
            w.destroy()

    def _nav_highlight(self, index):
        for i, b in enumerate(self._nav_btns):
            b.configure(fg_color="#38bdf8" if i == index else "transparent",
                        text_color="#0f172a" if i == index else "#cbd5e1",
                        hover_color="#1e293b")

    # ---------------- views ----------------
    def show_library(self):
        self.current_view = "library"
        self._nav_highlight(0)
        self._clear()
        self._slot_combo.configure(command=lambda _: self._refresh_card_labels())
        frame = ctk.CTkScrollableFrame(self._content, label_text="مكتبة البريسيتات")
        frame.pack(fill="both", expand=True)
        presets = self._load_presets()
        if not presets:
            ctk.CTkLabel(frame, text="لا توجد بريسيتات في presets/library", text_color="#94a3b8").pack(pady=20)
        for path, p in presets:
            Card(frame, p, path, self._slot_combo, self._set_status).pack(fill="x", padx=6, pady=7)

    def _refresh_card_labels(self):
        frame = self._content.winfo_children()[1]
        for w in frame.winfo_children():
            if isinstance(w, Card):
                w.refresh_label()

    def show_creator(self):
        self.current_view = "creator"
        self._nav_highlight(1)
        self._clear()
        sw = ctk.CTkScrollableFrame(self._content, label_text="منشئ البريسيت — حرّك المقابض ثم احفظ")
        sw.pack(fill="both", expand=True)

        self._sliders = {}
        for fname, controls in FILTERS:
            box = ctk.CTkFrame(sw, corner_radius=12, border_width=1, border_color="#2b3542")
            box.pack(fill="x", padx=6, pady=8)
            ctk.CTkLabel(box, text="◆ " + fname, font=ctk.CTkFont(size=15, weight="bold"),
                         text_color="#38bdf8").pack(anchor="w", padx=14, pady=(10, 4))
            self._sliders[fname] = {}
            for disp, lo, hi, step, default in controls:
                row = ctk.CTkFrame(box, fg_color="transparent")
                row.pack(fill="x", padx=14, pady=2)
                lbl = ctk.CTkLabel(row, text=disp, width=150, text_color="#cbd5e1", anchor="w")
                lbl.pack(side="left")
                val = ctk.CTkLabel(row, text=str(default), width=48, text_color="#e2e8f0", anchor="e")
                val.pack(side="right", padx=(4, 2))
                steps = int((hi - lo) / step)
                sld = ctk.CTkSlider(row, from_=lo, to=hi, number_of_steps=steps,
                                    command=lambda v, l=val: l.configure(text=str(int(round(v)))))
                sld.set(float(default))
                sld.pack(side="right", expand=True, fill="x", padx=8)
                self._sliders[fname][disp] = sld

        bar = ctk.CTkFrame(sw, fg_color="transparent")
        bar.pack(fill="x", padx=6, pady=(6, 12))
        ctk.CTkButton(bar, text="حفظ كبريسيت", fg_color="#059669", hover_color="#047857",
                      command=self._creator_save).pack(side="left", padx=4)
        ctk.CTkButton(bar, text="معاينة JSON", fg_color="#334155", hover_color="#475569",
                      command=self._creator_preview).pack(side="left", padx=4)
        ctk.CTkButton(bar, text="تطبيق الآن", fg_color="#3b82f6", hover_color="#2563eb",
                      command=self._creator_apply).pack(side="left", padx=4)

    def _creator_schema(self):
        filters = []
        for fname, controls in FILTERS:
            settings = {disp: int(round(self._sliders[fname][disp].get())) for disp, _, _, _, _ in controls}
            filters.append({"name": fname, "settings": settings})
        return {"preset_name": "custom-preset", "description": "بريست مخصص من منشئ القيم", "filters": filters}

    def _creator_save(self):
        path = os.path.join(PRESETS_DIR, "user-" + time.strftime("%Y%m%d-%H%M%S") + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self._creator_schema(), fh, ensure_ascii=False, indent=2)
        self._set_status("حُفظ: " + path)
        messagebox.showinfo("منشئ بريسيت", "حُفظ الملف:\n" + path)

    def _creator_preview(self):
        messagebox.showinfo("معاينة JSON",
                            json.dumps(self._creator_schema(), ensure_ascii=False, indent=2))

    def _creator_apply(self):
        path = os.path.join(PRESETS_DIR, "creator-now.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self._creator_schema(), fh, ensure_ascii=False, indent=2)
        self._set_status("جارٍ التطبيق... أغلق NVIDIA App إذا طُلب ذلك")
        res = run_backend("import", self._slot_combo.get(), path)
        self._set_status("تم التطبيق")
        messagebox.showinfo("استيراد", res)

    def show_games(self):
        self.current_view = "games"
        self._nav_highlight(2)
        self._clear()
        f = ctk.CTkFrame(self._content, fg_color="transparent")
        f.pack(fill="x", padx=6, pady=6)
        ctk.CTkButton(f, text="🔍  إعادة فحص الألعاب", command=self._scan_games).pack(side="left")
        self._games_list = ctk.CTkScrollableFrame(self._content, label_text="الألعاب المسجلة في مخزن NVIDIA")
        self._games_list.pack(fill="both", expand=True, pady=(8, 0))
        self._scan_games()

    def _scan_games(self):
        for w in self._games_list.winfo_children():
            w.destroy()
        running = self._running_exes()
        fp = self._read_store()
        keys = []
        if fp and fp.get("filterPresets"):
            keys = list(fp["filterPresets"].keys())
        if not keys:
            ctk.CTkLabel(self._games_list, text="لا توجد ألعاب مسجلة بعد (افتح Freestyle داخل لعبة مرة أولى).",
                         text_color="#94a3b8").pack(pady=30)
            return
        for path in keys:
            name = path.replace("\\", "/").split("/")[-1]
            is_running = name.lower() in running or (path.replace("\\", "/").lower() in running)
            card = ctk.CTkFrame(self._games_list, corner_radius=10, border_width=1, border_color="#2b3542")
            card.pack(fill="x", padx=6, pady=5)
            state = "▶ يجري الآن" if is_running else "غير مُشغّل"
            ctk.CTkLabel(card, text=state, text_color="#4ade80" if is_running else "#64748b",
                         font=ctk.CTkFont(size=11)).pack(side="right", padx=12)
            ctk.CTkLabel(card, text=name, font=ctk.CTkFont(size=13, weight="bold"),
                         text_color="#e2e8f0").pack(anchor="w", padx=14, pady=(10, 0))
            ctk.CTkLabel(card, text=path, text_color="#64748b", font=ctk.CTkFont(size=10)).pack(anchor="w", padx=14, pady=(0, 10))

    def show_backup(self):
        self.current_view = "backup"
        self._nav_highlight(3)
        self._clear()
        f = ctk.CTkFrame(self._content, height=56, corner_radius=12, fg_color="#1e293b")
        f.pack(fill="x", pady=4)
        f.pack_propagate(False)
        ctk.CTkButton(f, text="نسخ احتياطي الآن", fg_color="#059669", hover_color="#047857",
                      command=self._backup_now).pack(side="left", padx=10, pady=12)
        ctk.CTkButton(f, text="تصدير الحالي", fg_color="#334155", hover_color="#475569",
                      command=self._export_now).pack(side="left", padx=4, pady=12)
        ctk.CTkButton(f, text="استيراد من ملف", fg_color="#334155", hover_color="#475569",
                      command=self._import_file).pack(side="left", padx=4, pady=12)

        lst = ctk.CTkScrollableFrame(self._content, label_text="النسخ الاحتياطية المحفوظة")
        lst.pack(fill="both", expand=True, pady=(10, 0))
        labels = sorted(glob.glob(os.path.join(BACKUPS_DIR, "*")), reverse=True)
        for d in labels[:40]:
            if not os.path.isdir(d):
                continue
            row = ctk.CTkFrame(lst, corner_radius=10, border_width=1, border_color="#2b3542")
            row.pack(fill="x", padx=6, pady=4)
            ctk.CTkButton(row, text="استعادة", width=90, fg_color="#f59e0b", hover_color="#d97706",
                          command=lambda p=d: self._restore_label(p)).pack(side="right", padx=10, pady=8)
            ctk.CTkLabel(row, text=os.path.basename(d), text_color="#cbd5e1").pack(anchor="w", padx=12, pady=8)

    # ---------------- actions ----------------
    def refresh_all(self):
        self.update_game_status()
        if self.current_view == "library":
            self.show_library()
        elif self.current_view == "games":
            self.show_games()
        elif self.current_view == "backup":
            self.show_backup()

    def _backup_now(self):
        self._set_status("جار أخذ النسخة الاحتياطية...")
        res = run_backend("backup")
        self._set_status(res)
        ctk.CTkMessagebox(self, title="نسخ احتياطي", message=res)

    def _export_now(self):
        res = run_backend("export", "gui-" + time.strftime("%Y%m%d-%H%M%S"))
        self._set_status(res.replace("\n", " "))
        messagebox.showinfo("تصدير", res)

    def _import_file(self):
        path = filedialog.askopenfilename(title="اختر بريسيت JSON",
                                          filetypes=[("Preset JSON", "*.json")])
        if not path:
            return
        self._set_status("جارٍ التطبيق... أغلق NVIDIA App إذا طُلب ذلك")
        res = run_backend("import", self._slot_combo.get(), path)
        self._set_status("تم التطبيق")
        messagebox.showinfo("استيراد", res)

    def _restore_label(self, folder):
        label = os.path.basename(folder.rstrip("/\\"))
        res = run_backend("restore", label)
        messagebox.showinfo("استعادة", res)

    # ---------------- data helpers ----------------
    def _load_presets(self):
        out = []
        for p in sorted(glob.glob(os.path.join(PRESETS_DIR, "*.json"))):
            try:
                with open(p, encoding="utf-8") as fh:
                    out.append((p, json.load(fh)))
            except Exception:  # noqa: BLE001
                continue
        return out

    def _read_store(self):
        tmp = os.path.join(os.environ.get("TEMP", "."), "nv-manager-store.json")
        run_backend("json", tmp)
        try:
            with open(tmp, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:  # noqa: BLE001
            return None

    def _running_exes(self):
        out = set()
        try:
            p = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, timeout=20)
            txt = p.stdout.decode("utf-8", errors="replace")
            for line in txt.splitlines():
                if line.startswith('"'):
                    parts = line.split('","')
                    if parts:
                        out.add(parts[0].strip('"').lower())
        except Exception:  # noqa: BLE001
            pass
        return out

    def update_game_status(self):
        def _work():
            names = self._read_store_keys()
            running = self._running_exes()
            hit = None
            for path in names:
                base = path.replace("\\", "/").split("/")[-1].lower()
                if base in running or base + ".exe" in running:
                    hit = path
                    break
            return hit

        def _done(path):
            if path:
                self._game_lbl.configure(text="🎮 " + path.replace("\\", "/").split("/")[-1])
            else:
                self._game_lbl.configure(text="لا توجد لعبة شغّالة حالياً")

        def _runner():
            result = _work()
            self.after(0, lambda: _done(result))

        threading.Thread(target=_runner, daemon=True).start()

    def _read_store_keys(self):
        fp = self._read_store()
        if fp and fp.get("filterPresets"):
            return list(fp["filterPresets"].keys())
        return []


if __name__ == "__main__":
    app = App()
    app.mainloop()