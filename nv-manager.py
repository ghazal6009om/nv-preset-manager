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

try:
    from CTkMessagebox import CTkMessagebox as CTkMB
    _HAS_CTKMB = True
except Exception:  # noqa: BLE001
    _HAS_CTKMB = False

try:
    from PIL import Image, ImageDraw
    _HAS_PIL = True
except Exception:  # noqa: BLE001
    _HAS_PIL = False

from app_logic import NVFilterController, run_backend, ROOT, TMP_SCHEMA

PRESETS_DIR = os.path.join(ROOT, "presets", "library")
BACKUPS_DIR = os.path.join(ROOT, "backups")

_THUMB_CACHE = {}


def alert(kind, title, msg):
    if _HAS_CTKMB and kind in ("info", "ok", "question"):
        CTkMB(title=title, message=msg, icon=kind, option_1="حسناً")
    else:
        messagebox.showinfo(title, msg)


def _hex_rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _tint(hex_color, factor):
    r, g, b = _hex_rgb(hex_color)
    return int(r * factor), int(g * factor), int(b * factor)


def make_thumb(accent, w=720, h=92):
    key = (accent, w, h)
    if key in _THUMB_CACHE:
        return _THUMB_CACHE[key]
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    top = _tint(accent, 0.9)
    bottom = _tint(accent, 0.22)
    for y in range(h):
        t = y / (h - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=color)
    img = ctk.CTkImage(light_image=im, dark_image=im, size=(w, h))
    _THUMB_CACHE[key] = img
    return img

# (display name, min ui, max ui, ui step, default)
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


class ProfileBox(ctk.CTkFrame):
    """صندوق بروفايل (1/2/3) مع حالة نشطة مضيئة."""

    def __init__(self, master, profile_id, name, accent, on_click, **kw):
        super().__init__(master, corner_radius=16, border_width=1, border_color="#2b3542",
                         fg_color="#141c27", cursor="hand2", **kw)
        self.profile_id = profile_id
        self.accent = accent
        self.on_click = on_click

        ctk.CTkLabel(self, text=str(profile_id), font=ctk.CTkFont(size=30, weight="bold"),
                     text_color=accent).pack(anchor="w", padx=16, pady=(14, 0))

        self._name_lbl = ctk.CTkLabel(self, text=name, font=ctk.CTkFont(size=15, weight="bold"),
                                      text_color="#e2e8f0", justify="left")
        self._name_lbl.pack(anchor="w", padx=16, pady=(4, 0))

        self._count_lbl = ctk.CTkLabel(self, text="", font=ctk.CTkFont(size=11),
                                       text_color="#64748b", justify="left")
        self._count_lbl.pack(anchor="w", padx=16, pady=(0, 12))

        self.set_active(False)
        for w in (self, self._name_lbl, self._count_lbl):
            w.bind("<Button-1>", lambda e: self.on_click(self.profile_id))

    def _hover(self, seq):
        if seq == "<Enter>":
            self.configure(border_color="#3b82f6")
        elif seq == "<Leave>":
            self._restore()

    def set_active(self, active):
        self.active = active
        self._restore()

    _drag_hover = False

    def set_drag_hover(self, on):
        self._drag_hover = bool(on)
        if on:
            self.configure(border_color="#22c55e", border_width=3)
        else:
            self._restore()

    def _restore(self):
        if getattr(self, "active", False):
            self.configure(border_color=self.accent, border_width=3)
            self._count_lbl.configure(text_color=self.accent)
        else:
            self.configure(border_color="#2b3542", border_width=1)
            self._count_lbl.configure(text_color="#64748b")

    def set_name(self, name):
        self._name_lbl.configure(text=name)

    def set_count(self, n):
        self._count_lbl.configure(text=f"{n} فلتر")


class MiniCard(ctk.CTkFrame):
    """بطاقة بريسيت مدمجة - تحميل للخانة النشطة + سحب وإفلات."""

    def __init__(self, master, preset, preset_path, on_use, app, **kw):
        super().__init__(master, corner_radius=12, border_width=1, border_color="#2b3542", **kw)
        self.preset = preset
        self.preset_path = preset_path
        self.app = app
        accent = preset.get("accent", "#3b82f6")
        name = preset.get("preset_name", "بريست")

        if _HAS_PIL:
            thumb = ctk.CTkLabel(self, image=make_thumb(accent, 720, 84),
                                 text="", height=84)
            thumb.pack(fill="x", padx=8, pady=(8, 4))
        else:
            strip = ctk.CTkFrame(self, fg_color=accent, corner_radius=6, height=5)
            strip.pack(fill="x", padx=8, pady=(8, 6))

        ctk.CTkLabel(self, text=name, font=ctk.CTkFont(size=14, weight="bold"),
                     text_color="#e2e8f0").pack(anchor="w", padx=12, pady=(2, 2))
        chips = "  ".join(f["name"] for f in preset.get("filters", []))
        if chips:
            ctk.CTkLabel(self, text=chips, text_color="#64748b",
                         font=ctk.CTkFont(size=10)).pack(anchor="w", padx=12, pady=(0, 6))

        self._load_btn = ctk.CTkButton(self, height=30, corner_radius=8,
                                       fg_color="#1e293b", hover_color="#334155",
                                       text_color="#cbd5e1", font=ctk.CTkFont(size=12, weight="bold"),
                                       command=lambda: on_use(preset_path))
        self._load_btn.pack(fill="x", padx=10, pady=(2, 10))
        self._bind_drag(accent)

    def _bind_drag(self, accent):
        targets = [self._canvas]
        for lbl in self.winfo_children():
            if isinstance(lbl, ctk.CTkLabel):
                for attr in ("_label", "_canvas"):
                    w = getattr(lbl, attr, None)
                    if w is not None:
                        targets.append(w)
        for w in targets:
            w.bind("<ButtonPress-1>",
                   lambda e, c=self: self.app._dnd_start(e, c), add="+")

    def set_slot_button(self, slot):
        self._load_btn.configure(text=f"تحميل للخانة {slot} ⚡")


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("NV Preset Manager")
        self.geometry("1040x700")
        self.minsize(900, 640)
        ctk.set_appearance_mode("Dark")
        ctk.set_default_color_theme("blue")

        self.controller = NVFilterController()
        self.active_id = self.controller.current_profile
        self.current_view = None
        self._drag = None
        self._drag_hover_slot = None
        self._mini_cards = []

        self._build_sidebar()
        self._content = ctk.CTkFrame(self, fg_color="transparent")
        self._content.pack(side="right", fill="both", expand=True, padx=(0, 14), pady=(6, 14))
        self._build_header()

        self.bind_all("<B1-Motion>", self._dnd_motion)
        self.bind_all("<ButtonRelease-1>", self._dnd_end)

        self.show_dashboard()
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
            ("🎯  البروفايلات", self.show_dashboard, "#38bdf8"),
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

        ctk.CTkLabel(sb, text="البروفايلات تُقرأ من مخزن NVIDIA",
                     text_color="#475569", font=ctk.CTkFont(size=10)).pack(side="bottom", pady=12)

    def _build_header(self):
        hd = ctk.CTkFrame(self._content, corner_radius=12, fg_color="#1e293b", height=56)
        hd.pack(fill="x", pady=(0, 10))
        hd.pack_propagate(False)

        self._game_lbl = ctk.CTkLabel(hd, text="جارٍ فحص اللعبة...", font=ctk.CTkFont(size=13, weight="bold"),
                                      text_color="#e2e8f0")
        self._game_lbl.pack(side="left", padx=14)

        ctk.CTkButton(hd, text="⟳ تحديث من المخزن", width=120, height=30, fg_color="#334155",
                      hover_color="#475569", command=self.refresh_all).pack(side="right", padx=10)

        self._status = ctk.CTkLabel(hd, text="جاهز", text_color="#94a3b8", font=ctk.CTkFont(size=11))
        self._status.pack(side="right", padx=8)

    def _set_status(self, text):
        self._status.configure(text=str(text)[:80])
        self.update_idletasks()

    def _clear(self):
        for w in self._content.winfo_children()[1:]:
            w.destroy()

    def _nav_highlight(self, index):
        for i, b in enumerate(self._nav_btns):
            b.configure(fg_color="#38bdf8" if i == index else "transparent",
                        text_color="#0f172a" if i == index else "#cbd5e1",
                        hover_color="#1e293b")

    # ---------------- الرئيسية: البروفايلات ----------------
    def show_dashboard(self):
        self.current_view = "dashboard"
        self._nav_highlight(0)
        self._clear()
        body = ctk.CTkScrollableFrame(self._content)
        body.pack(fill="both", expand=True)

        # شريط الخانات الثلاث
        boxes = ctk.CTkFrame(body, fg_color="transparent")
        boxes.pack(fill="x", padx=6, pady=(2, 8))
        cols = boxes.grid_columnconfigure((0, 1, 2), weight=1, uniform="box")

        self._boxes = {}
        for i in (1, 2, 3):
            prof = self.controller.data["profiles"].get(str(i), {})
            accent = {"1": "#38bdf8", "2": "#a855f7", "3": "#22c55e"}.get(str(i), "#38bdf8")
            mb = ProfileBox(boxes, i, prof.get("name", f"بروفايل {i}"), accent,
                            lambda pid=i: self.select_profile(pid))
            mb.id = i
            mb.set_count(len(prof.get("filters", [])))
            mb.grid(row=0, column=i - 1, sticky="news", padx=6, pady=4, ipady=10)
            self._boxes[i] = mb

        # منتصف: قائمة الفلاتر النشطة + بطاقات المكتبة
        mid = ctk.CTkFrame(body, fg_color="transparent")
        mid.pack(fill="both", expand=True, padx=6)
        mid.grid_columnconfigure(0, weight=1, minsize=420)
        mid.grid_columnconfigure(1, weight=0, minsize=360)
        mid.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(mid, fg_color="transparent")
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        self._filters_panel = ctk.CTkScrollableFrame(left, label_text="الفلاتر النشطة في الخانة الحالية",
                                                     fg_color="#131a24", corner_radius=14)
        self._filters_panel.pack(fill="both", expand=True)

        # أزرار العمل
        bar = ctk.CTkFrame(left, fg_color="#131a24", corner_radius=14, height=66)
        bar.pack(fill="x", pady=(10, 0))
        bar.pack_propagate(False)
        ctk.CTkButton(bar, text="📥 استيراد", fg_color="#334155", hover_color="#475569",
                      command=self._import_to_active).pack(side="left", padx=(12, 4), pady=14)
        ctk.CTkButton(bar, text="📤 تصدير", fg_color="#334155", hover_color="#475569",
                      command=self._export_active).pack(side="left", padx=4, pady=14)
        ctk.CTkButton(bar, text="⚡ تطبيق (Alt+F3)", fg_color="#3b82f6", hover_color="#2563eb",
                      command=self._apply_active).pack(side="right", padx=12, pady=14)

        right = ctk.CTkFrame(mid, fg_color="transparent")
        right.grid(row=0, column=1, sticky="nsew")
        ctk.CTkLabel(right, text="📥 مكتبة البريسيتات (Preset Library)",
                     font=ctk.CTkFont(size=14, weight="bold"),
                     text_color="#cbd5e1").pack(anchor="w")
        ctk.CTkLabel(right, text="اسحب بريسيتاً وأفلته على خانة 1/2/3 للصقه (يُطبَّق لاحقاً)",
                     text_color="#64748b", font=ctk.CTkFont(size=10)).pack(anchor="w")
        lib = ctk.CTkScrollableFrame(right, fg_color="#131a24", corner_radius=14)
        lib.pack(fill="both", expand=True, pady=(6, 0))
        presets = self._load_presets()
        if not presets:
            ctk.CTkLabel(lib, text="لا توجد بريسيتات في presets/library",
                         text_color="#94a3b8").pack(pady=20)
        self._mini_cards = []
        for path, p in presets:
            card = MiniCard(lib, p, path, self._library_use, self)
            card.pack(fill="x", padx=4, pady=5)
            card.set_slot_button(self.active_id)
            self._mini_cards.append(card)

        self._render_filters()
        self._refresh_boxes_active()

    def _refresh_mini_buttons(self):
        for card in getattr(self, "_mini_cards", []):
            try:
                card.set_slot_button(self.active_id)
            except Exception:  # noqa: BLE001
                pass

    # ---------------- السحب والإفلات (Drag & Drop) ----------------
    def _dnd_start(self, event, card):
        self._drag = card
        self._drag_hover_slot = None
        self._set_status(f"جارٍ السحب: {card.preset.get('preset_name', '')} — أسقطه على خانة 1/2/3")

    def _dnd_motion(self, event):
        if not getattr(self, "_drag", None):
            return
        slot = self._slot_at(event.x_root, event.y_root)
        if slot != self._drag_hover_slot:
            self._clear_slot_hover()
            self._drag_hover_slot = slot
            if slot:
                self._boxes[slot].set_drag_hover(True)

    def _dnd_end(self, event):
        if not getattr(self, "_drag", None):
            return
        card = self._drag
        self._drag = None
        self._clear_slot_hover()
        slot = self._slot_at(event.x_root, event.y_root)
        if slot:
            self.controller.import_profile(card.preset_path, slot=slot)
            self.select_profile(slot)
            self._refresh_mini_buttons()
            self._set_status(f"لُصق {card.preset.get('preset_name', '')} في الخانة {slot} — جاهز للتطبيق (Alt+F3)")
        else:
            self._set_status("لم تُسقط فوق خانة — جرّب مجدداً")

    def _slot_at(self, x, y):
        boxes = getattr(self, "_boxes", None)
        if not boxes:
            return None
        for i, box in boxes.items():
            try:
                if not box.winfo_exists():
                    continue
                rx, ry = box.winfo_rootx(), box.winfo_rooty()
                w, h = box.winfo_width(), box.winfo_height()
                if w > 10 and rx <= x <= rx + w and ry <= y <= ry + h:
                    return i
            except Exception:  # noqa: BLE001
                pass
        return None

    def _clear_slot_hover(self):
        for slot, box in getattr(self, "_boxes", {}).items():
            box.set_drag_hover(False)

    def select_profile(self, pid):
        self.controller.select_profile(pid)
        self.active_id = pid
        boxes = getattr(self, "_boxes", None)
        if boxes and self.current_view == "dashboard":
            self._refresh_boxes_active()
            self._render_filters()
            self._refresh_mini_buttons()
        self._set_status(f"الخانة {pid} نشطة")

    def _refresh_boxes_active(self):
        for i, box in self._boxes.items():
            prof = self.controller.data["profiles"].get(str(i), {})
            box.set_name(prof.get("name", f"بروفايل {i}"))
            box.set_count(len(prof.get("filters", [])))
            box.set_active(i == self.active_id)

    def _render_filters(self):
        for w in self._filters_panel.winfo_children():
            w.destroy()
        prof = self.controller.data["profiles"].get(str(self.active_id), {})
        filters = prof.get("filters", [])
        ctk.CTkLabel(self._filters_panel, text="الخانة النشطة: " + str(self.active_id),
                     font=ctk.CTkFont(size=12, weight="bold"),
                     text_color="#38bdf8").pack(anchor="w", padx=12, pady=(8, 2))
        if not filters:
            ctk.CTkLabel(self._filters_panel,
                         text="لا توجد فلاتر نشطة.\nافتح Freestyle داخل اللعبة (Alt+F3)\nأو استورد/حمّل بريسيت إلى هذه الخانة.",
                         text_color="#94a3b8", justify="left").pack(anchor="w", padx=12, pady=8)
            return
        for f in filters:
            fname = f.get("name", "?")
            box = ctk.CTkFrame(self._filters_panel, corner_radius=10, border_width=1,
                               border_color="#2b3542", fg_color="#141c27")
            box.pack(fill="x", padx=6, pady=4)
            accent = {"Color": "#38bdf8", "Details": "#22d3ee",
                      "Brightness / Contrast": "#a855f7", "Vignette": "#f59e0b"}.get(fname, "#cbd5e1")
            ctk.CTkLabel(box, text="◆ " + fname, font=ctk.CTkFont(size=13, weight="bold"),
                         text_color=accent).pack(anchor="w", padx=12, pady=(8, 2))
            settings = f.get("settings", {})
            for k, v in settings.items():
                ctk.CTkLabel(box, text=f"{k}:  {v}",
                             text_color="#cbd5e1",
                             font=ctk.CTkFont(size=12)).pack(anchor="w", padx=14, pady=(0, 5))
            ctk.CTkLabel(box, text="", width=1).pack()

    # ---------------- أزرار الخانة النشطة ----------------
    def _library_use(self, path):
        self.controller.import_profile(path)
        self._set_status(f"تم تحميل البريسيت على الخانة {self.active_id}")
        self._refresh_boxes_active()
        self._render_filters()
        self._refresh_mini_buttons()

    def _import_to_active(self):
        prof = self.controller.import_profile()
        if prof:
            self._set_status(f"تم استيراد البريسيت للخانة {self.active_id}")
            self._refresh_boxes_active()
            self._render_filters()
            self._refresh_mini_buttons()

    def _export_active(self):
        path = self.controller.export_profile()
        if path:
            self._set_status("تم التصدير: " + path)

    def _apply_active(self):
        self._set_status("جارٍ التطبيق... أغلق NVIDIA App إذا طُلب ذلك")
        def _run():
            res = self.controller.apply_to_nvidia()
            self.after(0, lambda: self._apply_done(res))
        threading.Thread(target=_run, daemon=True).start()

    def _apply_done(self, res):
        self._set_status("اكتمل التطبيق")
        alert("info", "تطبيق",
              f"النتيجة:\n{res}\n\n"
              "افتح اللعبة واضغط Alt+F3 لتفعيل الفلاتر.\n"
              "ملاحظة: الكتابة في مخزن NVIDIA تتطلب إغلاق NVIDIA App مؤقتاً.")

    # ---------------- منشئ بريسيت ----------------
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
                ctk.CTkLabel(row, text=disp, width=150, text_color="#cbd5e1",
                             anchor="w").pack(side="left")
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
            settings = {disp: int(round(self._sliders[fname][disp].get()))
                        for disp, _, _, _, _ in controls}
            filters.append({"name": fname, "settings": settings})
        return {"preset_name": "custom-preset", "description": "بريست مخصص من منشئ القيم",
                "filters": filters}

    def _creator_save(self):
        path = os.path.join(PRESETS_DIR, "user-" + time.strftime("%Y%m%d-%H%M%S") + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self._creator_schema(), fh, ensure_ascii=False, indent=2)
        self._set_status("حُفظ: " + path)
        alert("info", "منشئ بريسيت", "حُفظ الملف:\n" + path)

    def _creator_preview(self):
        alert("info", "معاينة JSON",
              json.dumps(self._creator_schema(), ensure_ascii=False, indent=2))

    def _creator_apply(self):
        with open(TMP_SCHEMA, "w", encoding="utf-8") as fh:
            json.dump(self._creator_schema(), fh, ensure_ascii=False, indent=2)
        self._set_status("جارٍ التطبيق... أغلق NVIDIA App إذا طُلب ذلك")
        res = run_backend("import", str(self.active_id), TMP_SCHEMA)
        self._set_status("تم التطبيق")
        alert("info", "استيراد", res)

    # ---------------- الألعاب ----------------
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
            ctk.CTkLabel(card, text=path, text_color="#64748b",
                         font=ctk.CTkFont(size=10)).pack(anchor="w", padx=14, pady=(0, 10))

    # ---------------- نسخ واستعادة ----------------
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
        self.controller.sync_from_nvidia()
        self.active_id = self.controller.current_profile
        self.update_game_status()
        if self.current_view == "dashboard":
            self.show_dashboard()
        elif self.current_view == "creator":
            self.show_creator()
        elif self.current_view == "games":
            self.show_games()
        elif self.current_view == "backup":
            self.show_backup()

    def _backup_now(self):
        self._set_status("جار أخذ النسخة الاحتياطية...")
        res = run_backend("backup")
        self._set_status(res)
        messagebox.showinfo("نسخ احتياطي", res)

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
        res = run_backend("import", str(self.active_id), path)
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
        return self.controller._read_store()

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