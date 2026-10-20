import sys, pypdf, re
data = open(sys.argv[1], 'rb').read()
# найдём все "N 0 obj" и напечатаем словари
for m in re.finditer(rb'(\d+) 0 obj\r?\n(<<.*?>>)\r?\n', data, re.S):
    d = m.group(2)[:400].decode('latin-1').replace('\n', ' ')
    print(m.group(1).decode(), ':', d[:300])
print('---- ExtGState объекты ----')
r = pypdf.PdfReader(sys.argv[1])
res = r.pages[0]['/Resources']
print('res keys:', list(res.keys()))
gs = res.get('/ExtGState')
if gs:
    for k in gs:
        print(k, dict(gs[k].get_object()))
