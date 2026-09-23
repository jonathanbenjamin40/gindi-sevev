# /api/signing/fill-contract.py
#
# Phase 1 of the digital-signing module: fills the text placeholders
# (\tag\ anchors, both the plain ones and the ones hidden in document
# metadata) in every .docx in a Drive folder, using the client details
# submitted from the "חיתום" screen's popup.
#
# Request body (JSON):
#   { "fileId": "<Drive file id of the source .docx>",
#     "fields": { "b1_name": "...", "b1_id": "...", ... } }
#
# Response (JSON):
#   { "ok": true, "fileId": "<new file id>", "viewUrl": "...", "name": "..." }
#
# Runs as a Python Vercel function (separate runtime from the rest of the
# API, which is Node.js) because the actual docx-filling logic needs
# python-docx/lxml — there's no equivalently mature library for this on
# the Node side, and this exact engine was validated against a real
# 113-page contract before being wired in here.

from http.server import BaseHTTPRequestHandler
import json
import os
import re
import zipfile
from io import BytesIO
import requests
from lxml import etree

TAG_RE = re.compile(r'\\([a-zA-Z0-9_]+)\\')
W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def qn(tag):
    prefix, local = tag.split(':')
    ns = {'w': W_NS, 'xml': 'http://www.w3.org/XML/1998/namespace'}[prefix]
    return '{%s}%s' % (ns, local)


# ---------- Same engine proven against the real contract earlier ----------

def fill_wordprocessing_part(xml_bytes, field_values, counts):
    root = etree.fromstring(xml_bytes)
    for p in root.iter(qn('w:p')):
        runs = p.findall('.//' + qn('w:r'))
        if not runs:
            continue

        def run_text(r):
            return "".join(t.text or "" for t in r.findall(qn('w:t')))

        full_text = ""
        spans = []
        for i, r in enumerate(runs):
            t = run_text(r)
            start = len(full_text)
            full_text += t
            spans.append((i, start, start + len(t)))

        matches = list(TAG_RE.finditer(full_text))
        if not matches:
            continue

        for m in reversed(matches):
            tag = m.group(1)
            if tag not in field_values:
                continue
            value = str(field_values[tag])
            m_start, m_end = m.start(), m.end()
            touched = [ri for (ri, s, e) in spans if e > m_start and s < m_end]
            if not touched:
                continue
            first_ri = touched[0]
            first_run = runs[first_ri]
            first_s = spans[first_ri][1]
            last_e = spans[touched[-1]][2]
            prefix = full_text[first_s:m_start]
            suffix = full_text[m_end:last_e]

            t_elements = first_run.findall(qn('w:t'))
            new_text = prefix + value + suffix
            if t_elements:
                t_elements[0].text = new_text
                t_elements[0].set(qn('xml:space'), 'preserve')
                for extra in t_elements[1:]:
                    first_run.remove(extra)
            else:
                t_el = etree.SubElement(first_run, qn('w:t'))
                t_el.text = new_text
                t_el.set(qn('xml:space'), 'preserve')

            rPr = first_run.find(qn('w:rPr'))
            if rPr is not None:
                for prop_tag in ('w:color', 'w:vanish', 'w:highlight'):
                    el = rPr.find(qn(prop_tag))
                    if el is not None:
                        rPr.remove(el)

            for ri in touched[1:]:
                for t in runs[ri].findall(qn('w:t')):
                    t.text = ""

            counts[tag] = counts.get(tag, 0) + 1

    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


def fill_metadata_part(xml_bytes, field_values, counts):
    text = xml_bytes.decode('utf-8')

    def repl(m):
        tag = m.group(1)
        if tag in field_values:
            counts[tag] = counts.get(tag, 0) + 1
            return str(field_values[tag])
        return m.group(0)

    return TAG_RE.sub(repl, text).encode('utf-8')


DOC_PARTS = re.compile(r'^word/(document|header\d*|footer\d*)\.xml$')
METADATA_PARTS = re.compile(r'^(docProps/(core|app)\.xml|customXml/item\d+\.xml)$')


def fill_document_bytes(docx_bytes, field_values):
    counts = {}
    src = zipfile.ZipFile(BytesIO(docx_bytes), 'r')
    out_buf = BytesIO()
    out = zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED)
    for name in src.namelist():
        data = src.read(name)
        if DOC_PARTS.match(name):
            data = fill_wordprocessing_part(data, field_values, counts)
        elif METADATA_PARTS.match(name):
            data = fill_metadata_part(data, field_values, counts)
        out.writestr(name, data)
    out.close()
    return out_buf.getvalue(), counts


# ---------- Google Drive access (direct REST calls, no heavy SDK) ----------

def get_access_token():
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    })
    resp.raise_for_status()
    return resp.json()["access_token"]


def drive_get_metadata(file_id, token):
    r = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        params={"fields": "id,name,parents,mimeType"},
        headers={"Authorization": f"Bearer {token}"},
    )
    r.raise_for_status()
    return r.json()


def drive_download(file_id, token):
    r = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
    )
    r.raise_for_status()
    return r.content


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def drive_upload_new_file(name, content_bytes, parent_id, token):
    metadata = {"name": name, "parents": [parent_id] if parent_id else []}
    boundary = "gindi_signing_boundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {DOCX_MIME}\r\n\r\n"
    ).encode("utf-8") + content_bytes + f"\r\n--{boundary}--".encode("utf-8")

    r = requests.post(
        "https://www.googleapis.com/upload/drive/v3/files",
        params={"uploadType": "multipart", "fields": "id, webViewLink, name"},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        data=body,
    )
    r.raise_for_status()
    return r.json()


def build_filled_name(original_name):
    base = original_name
    if base.lower().endswith(".docx"):
        base = base[:-5]
    return base + " - מולא.docx"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            file_id = body.get("fileId")
            field_values = body.get("fields") or {}
            if not file_id:
                self._json(400, {"ok": False, "error": "Missing fileId"})
                return

            token = get_access_token()
            meta = drive_get_metadata(file_id, token)
            parent_id = (meta.get("parents") or [None])[0]
            docx_bytes = drive_download(file_id, token)
            filled_bytes, counts = fill_document_bytes(docx_bytes, field_values)
            new_name = build_filled_name(meta.get("name", "מסמך.docx"))
            uploaded = drive_upload_new_file(new_name, filled_bytes, parent_id, token)

            self._json(200, {
                "ok": True,
                "fileId": uploaded.get("id"),
                "name": uploaded.get("name"),
                "viewUrl": uploaded.get("webViewLink"),
                "replacedCounts": counts,
            })
        except requests.HTTPError as e:
            self._json(502, {"ok": False, "error": "Google API error", "detail": str(e)})
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})

    def _json(self, status, payload):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
