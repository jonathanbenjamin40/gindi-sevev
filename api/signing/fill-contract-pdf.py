# /api/signing/fill-contract-pdf.py
#
# The signing module's core engine — PDF-only, per the decision to
# standardize the whole document set on PDF (source Word documents are
# saved as PDF before upload, so this is the single engine for everything).
#
# Given a set of PDF files in an apartment's Drive folder plus the client
# details submitted from the "חיתום" screen's popup:
#   1. Downloads each source PDF.
#   2. Finds every \tag\ anchor in each page's real text layer (these are
#      the same anchors used by the old DocuSign flow) and replaces it with
#      the matching value — handling page rotation (drawings are often
#      rotated 90°) and Hebrew right-to-left display order correctly.
#   3. Merges all the filled PDFs into ONE combined document, in the same
#      order as the source files.
#   4. Uploads the merged PDF back into the same Drive folder.
#
# Request body (JSON):
#   { "fileIds": ["<Drive file id>", ...],   // in the order to merge them
#     "folderName": "<used to name the output file>",
#     "fields": { "b1_name": "...", "b1_id": "...", ... } }
#
# Response (JSON):
#   { "ok": true, "fileId": "...", "viewUrl": "...", "name": "...",
#     "perFile": [ {"name": "...", "replacedCount": N}, ... ] }

from http.server import BaseHTTPRequestHandler
import json
import os
import re
from io import BytesIO
import requests
import pymupdf
from bidi.algorithm import get_display

TAG_RE = re.compile(r'\\([a-zA-Z0-9_]+)\\')
FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "MiriamCLM-Book.ttf")
FONT_NAME = "miriamclm"


def fill_pdf_bytes(pdf_bytes, field_values):
    """Returns (filled_pdf_bytes, replaced_count) — unknown tags are left
    untouched (e.g. buyers_signature/gindi_stamp/date_signature, which are
    handled by a later phase, not this text-fill step)."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    replaced = 0

    for page in doc:
        original_rotation = page.rotation
        if original_rotation != 0:
            page.set_rotation(0)  # match get_text's coordinate space

        d = page.get_text("dict")
        to_fill = []
        for block in d["blocks"]:
            if "lines" not in block:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    raw = span["text"].strip()
                    inner = raw.strip("\\")
                    if raw.startswith("\\") and raw.endswith("\\") and inner in field_values:
                        to_fill.append((pymupdf.Rect(span["bbox"]), field_values[inner], span["size"], line["dir"]))

        for rect, _val, _size, _dir in to_fill:
            page.add_redact_annot(rect, fill=(1, 1, 1))
        if to_fill:
            page.apply_redactions()

        for rect, val, size, dir_ in to_fill:
            rotate = 90 if dir_[1] < 0 else (270 if dir_[1] > 0 else 0)
            point = pymupdf.Point(rect.x0, rect.y1)
            display_val = get_display(str(val))
            page.insert_text(point, display_val, fontsize=size, fontfile=FONT_PATH,
                              fontname=FONT_NAME, color=(0, 0, 0), rotate=rotate)
            replaced += 1

        if original_rotation != 0:
            page.set_rotation(original_rotation)

    out = BytesIO()
    doc.save(out)
    return out.getvalue(), replaced


def merge_pdfs(pdf_byte_list):
    merged = pymupdf.open()
    for b in pdf_byte_list:
        src = pymupdf.open(stream=b, filetype="pdf")
        merged.insert_pdf(src)
    out = BytesIO()
    merged.save(out)
    return out.getvalue()


# ---------- Google Drive access (same pattern as fill-contract.py) ----------

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


PDF_MIME = "application/pdf"


def drive_upload_new_file(name, content_bytes, parent_id, token):
    metadata = {"name": name, "parents": [parent_id] if parent_id else []}
    boundary = "gindi_signing_boundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {PDF_MIME}\r\n\r\n"
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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            file_ids = body.get("fileIds") or []
            field_values = body.get("fields") or {}
            folder_name = body.get("folderName") or "מסמכים"
            if not file_ids:
                self._json(400, {"ok": False, "error": "Missing fileIds"})
                return

            token = get_access_token()
            filled_parts = []
            per_file = []
            parent_id = None
            for fid in file_ids:
                meta = drive_get_metadata(fid, token)
                if parent_id is None:
                    parent_id = (meta.get("parents") or [None])[0]
                raw = drive_download(fid, token)
                filled, count = fill_pdf_bytes(raw, field_values)
                filled_parts.append(filled)
                per_file.append({"name": meta.get("name"), "replacedCount": count})

            merged = merge_pdfs(filled_parts)
            out_name = folder_name + " - מלא וחתום.pdf"
            uploaded = drive_upload_new_file(out_name, merged, parent_id, token)

            self._json(200, {
                "ok": True,
                "fileId": uploaded.get("id"),
                "name": uploaded.get("name"),
                "viewUrl": uploaded.get("webViewLink"),
                "perFile": per_file,
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
