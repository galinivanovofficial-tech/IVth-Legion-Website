# Turns the course .docx into HTML shaped like a Google Docs export (h1/h2/h3, p with styled spans, tables,
# images as data URIs) so src/education.js convert() can build the Academy from the Word file directly.
#   python3 scripts/docx_to_html.py course.docx out.html
import sys, zipfile, re, base64, html
from xml.etree import ElementTree as ET
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A='{http://schemas.openxmlformats.org/drawingml/2006/main}'
z=zipfile.ZipFile(sys.argv[1])
doc=ET.fromstring(z.read('word/document.xml')); rels=ET.fromstring(z.read('word/_rels/document.xml.rels'))
rid={r.get('Id'):r.get('Target') for r in rels}
fmt={}
try:
  num=ET.fromstring(z.read('word/numbering.xml'))
  absfmt={a.get(W+'abstractNumId'):a.find(f'{W}lvl/{W}numFmt').get(W+'val') for a in num.findall(W+'abstractNum')}
  for n in num.findall(W+'num'): fmt[n.get(W+'numId')]=absfmt.get(n.find(W+'abstractNumId').get(W+'val'),'bullet')
except KeyError: pass
def img(blip):
  t=rid.get(blip.get(R+'embed'),''); 
  if not t: return ''
  data=z.read('word/'+t); ext='jpeg' if t.lower().endswith(('jpg','jpeg')) else 'png'
  return f'<img alt="" src="data:image/{ext};base64,{base64.b64encode(data).decode()}">'
def runs(p):
  out=[]
  for r in p.iter(W+'r'):
    rp=r.find(W+'rPr'); b=rp is not None and rp.find(W+'b') is not None and rp.find(W+'b').get(W+'val') not in ('0','false')
    i=rp is not None and rp.find(W+'i') is not None and rp.find(W+'i').get(W+'val') not in ('0','false')
    s=''
    for c in r:
      if c.tag==W+'t': s+=html.escape(c.text or '')
      elif c.tag==W+'br': s+='<br>'
      elif c.tag==W+'tab': s+=' '
      elif c.tag==W+'drawing':
        for bl in c.iter(A+'blip'): s+=img(bl)
    if s: out.append(f'<span class="{"c1" if b else "c0"}{" c2" if i else ""}">{s}</span>')
  return ''.join(out)
def para(p):
  pp=p.find(W+'pPr'); st=pp.find(W+'pStyle').get(W+'val') if pp is not None and pp.find(W+'pStyle') is not None else ''
  inner=runs(p)
  if st.startswith('Heading') and st[-1] in '123':
    return f'<h{st[-1]}>{re.sub(r"<br>"," ",inner)}</h{st[-1]}>',None
  nid=pp.find(f'{W}numPr/{W}numId') if pp is not None else None
  if nid is not None: return f'<li><p>{inner}</p></li>', ('ol' if fmt.get(nid.get(W+'val'))=='decimal' else 'ul')
  return f'<p>{inner}</p>',None
def table(t):
  rows=''.join('<tr>'+''.join('<td>'+''.join(para(p)[0] if p.tag==W+'p' else table(p) for p in tc if p.tag in (W+'p',W+'tbl'))+'</td>' for tc in tr.findall(W+'tc'))+'</tr>' for tr in t.findall(W+'tr'))
  return f'<table><tbody>{rows}</tbody></table>'
out=[]; lst=None
for el in doc.find(W+'body'):
  if el.tag==W+'p':
    h,kind=para(el)
    if kind!=lst:
      if lst: out.append(f'</{lst}>')
      if kind: out.append(f'<{kind}>')
      lst=kind
    out.append(h)
  elif el.tag==W+'tbl':
    if lst: out.append(f'</{lst}>'); lst=None
    out.append(table(el))
if lst: out.append(f'</{lst}>')
open(sys.argv[2],'w').write('<html><head><style>.c0{font-weight:400}.c1{font-weight:700}.c2{font-style:italic}</style></head><body>'+''.join(out)+'</body></html>')
print('ok',len(out))
