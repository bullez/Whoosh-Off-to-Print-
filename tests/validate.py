import sys, pymupdf, pypdf

path = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else None

doc = pymupdf.open(path)
print("страниц:", doc.page_count)
for i, page in enumerate(doc):
    print(f"--- стр. {i+1}: MediaBox={tuple(round(v,2) for v in page.mediabox)} "
          f"TrimBox={tuple(round(v,2) for v in page.trimbox)} mm={page.rect.width/72*25.4:.2f}x{page.rect.height/72*25.4:.2f}")
    print("   изображений:", len(page.get_images(full=True)))
    print("   текста:", repr(page.get_text().strip()[:60]))

r = pypdf.PdfReader(path)
print("pypdf OK, страниц:", len(r.pages))
fonts = r.pages[0]["/Resources"].get("/Font")
print("шрифты:", {k: v.get_object().get("/BaseFont") for k, v in fonts.items()} if fonts else None)
xo = r.pages[0]["/Resources"].get("/XObject")
print("XObject:", list(xo.keys()) if xo else None)
if xo:
    for k in xo:
        o = xo[k].get_object()
        print("  ", k, o.get("/Subtype"), o.get("/Width"), "x", o.get("/Height"),
              o.get("/ColorSpace"), "SMask" if o.get("/SMask") else "")
sh = r.pages[0]["/Resources"].get("/Shading")
print("Shading:", list(sh.keys()) if sh else None)

content = r.pages[0].get_contents().get_data().decode("latin-1")
import re
print("CMYK-операторов k/K:", len(re.findall(r"\d .*? k\n", content)), len(re.findall(r" K\n", content)))
print("градиент sh:", content.count(" sh"), " изображений Do:", content.count(" Do"))

if out:
    for i, page in enumerate(doc):
        page.get_pixmap(dpi=96).save(out.replace(".png", f"_{i+1}.png"))
    print("рендеры сохранены")
