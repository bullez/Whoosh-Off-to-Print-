import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
page = doc[0]
# левый верхний угол (0,0) и область, где ожидаем жёлтый прямоугольник
clip = pymupdf.Rect(300, 700, 620, 900)  # в пунктах, y сверху
pix = page.get_pixmap(clip=clip, dpi=144)
pix.save(sys.argv[2])
print('ok', pix.width, pix.height)
print('пиксели в точке, где ожидаем жёлтый:', page.get_pixmap(clip=pymupdf.Rect(400, 780, 401, 781), dpi=72).pixel(0, 0))
print('текст страницы:', repr(page.get_text()))
bbox = page.get_text('words')
print('words:', bbox[:5])
