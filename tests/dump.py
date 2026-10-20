import sys, pypdf, re
r = pypdf.PdfReader(sys.argv[1])
c = r.pages[0].get_contents().get_data().decode('latin-1')
print(c)
