# NV Preset Manager

أداة لإدارة بريسيتات فلاتر **NVIDIA Freestyle / Game Filters** وتطبيقها على ألعابك، بصيغة NVIDIA الداخلية نفسها، مع خاصيتي **استيراد/تصدير** و**نسخ/استعادة**.

## ما الذي تفعله الأداة؟

- تقرأ فلاتر NVIDIA الحالية (Color / Details / Brightness-Contrast / Vignette) مباشرةً من مخزن NVIDIA الداخلي.
- تطبّق بريسيتات جاهزة (المكتبة) على أي خانة (Slot) من خانات Freestyle الثلاث.
- تصدّر استيراد فلاترك بصيغة `.nvpreset.json` — نفس الصيغة التي يفهمها NVIDIA نفسه.
- تأخذ نسخة احتياطية كاملة من مخزن الفلاتر وتعيدها عند الحاجة.
- تتوفّر أيضاً بواجهة رسومية (WinForms) تشبه صندوق Game Filters.

## التشغيل السريع

```
run.bat list                        # استعراض البريسات
run.bat slots                       # عرض الخانات المخزّنة بالفلاتر (نفس ما تراه في اللعبة)
run.bat export mypreset             # تصدير فلاترك الحالية إلى ملف .nvpreset.json
run.bat bake 1 vibrant-anime,crisp-realistic
run.bat backup                      # نسخة احتياطية كاملة من مخزن NVIDIA
run.bat restore <label>             # استعادة نسخة محفوظة
run.bat import 3 soft-cinematic     # تطبيق بريسيت على الخانة 3
gui.bat                             # تشغيل الواجهة الرسومية
```

## المفاهيم

| المصطلح | المعنى |
| --- | --- |
| الخانة (Slot) | مكان حفظ بريسيت داخل Freestyle (1/2/3) |
| البريست (Preset) | مجموعة فلاتر بقيم جاهزة |
| المكتبة | بريسيتات مبنية مسبقاً على نفس فلاتر NVIDIA |

### بريسيتات المكتبة الحالية

| الاسم | الوصف |
| --- | --- |
| `vibrant-anime` | ألوان زاهية تشبه رسوم الأنمي |
| `soft-cinematic` | تباين ناعم ومظهر سينمائي |
| `crisp-realistic` | وضوح وتفاصيل واقعية |

## ملاحظات مهمة

- **قبل استخدام `import` أو `restore`**: أغلق NVIDIA App واللعبة، لأن التطبيق يعيد كتابة المخزن لحظة فتحه.
- التطبيق يكتب بريسيتاً بصيغة NVIDIA الأصلية فقط (لا يلمس مصنّع الألعاب).
- البيانات المحفوظة في المجلد المحلي `backups\` و`collected\` لا تُرفع إلى GitHub (مستثناة في `.gitignore`).

## المتطلبات

- Windows 10/11
- Node.js 18 أو أحدث
- NVIDIA App أو GeForce Experience مع تفعيل Game Filters