# /api/signing/apply-signatures.py
#
# Phase 2/3 of the signing module: takes the already-merged, text-filled
# PDF (produced by fill-contract-pdf.py) and places the buyer signature(s),
# the Gindi stamp, and today's date into every occurrence of
# \buyers_signature\, \buyers_signature2\, \gindi_stamp\, \date_signature\
# — handling the same page-rotation quirks as the text engine, since these
# are typically right next to the text fields we already fill.
#
# Request body (JSON):
#   { "fileId": "<Drive file id of the merged PDF>",
#     "signature1": "<base64 PNG, buyer 1's signature>",
#     "signature2": "<base64 PNG, buyer 2's signature, or omitted/same as 1
#                     if signing together>",
#     "stamp": "<base64 PNG, Gindi stamp>",
#     "date": "22.9.2026" }
#
# Updates the SAME Drive file in place (so the folder keeps exactly one
# merged output file, per the earlier decision) and returns its info.

from http.server import BaseHTTPRequestHandler
import json
import os
import re
import base64
from io import BytesIO
import requests
import pymupdf
from PIL import Image
from bidi.algorithm import get_display

IMAGE_TAGS = {"buyers_signature", "buyers_signature2", "gindi_stamp"}
FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "MiriamCLM-Book.ttf")
FONT_NAME = "miriamclm"


def rotate_image_bytes(png_bytes, dir_):
    im = Image.open(BytesIO(png_bytes)).convert("RGBA")
    if dir_[1] < 0:
        im = im.rotate(90, expand=True)
    elif dir_[1] > 0:
        im = im.rotate(-90, expand=True)
    out = BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def apply_to_pdf_bytes(pdf_bytes, images_by_tag, date_str):
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    placed = {"buyers_signature": 0, "buyers_signature2": 0, "gindi_stamp": 0, "date_signature": 0}

    for page in doc:
        original_rotation = page.rotation
        if original_rotation != 0:
            page.set_rotation(0)

        d = page.get_text("dict")
        image_targets = []
        date_targets = []
        for block in d["blocks"]:
            if "lines" not in block:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    raw = span["text"].strip()
                    tag = raw.strip("\\")
                    if raw.startswith("\\") and raw.endswith("\\"):
                        rect = pymupdf.Rect(span["bbox"])
                        if tag in IMAGE_TAGS and tag in images_by_tag:
                            image_targets.append((rect, tag, line["dir"]))
                        elif tag == "date_signature" and date_str:
                            date_targets.append((rect, span["size"], line["dir"]))

        for rect, tag, dir_ in image_targets:
            page.add_redact_annot(rect, fill=(1, 1, 1))
        for rect, size, dir_ in date_targets:
            page.add_redact_annot(rect, fill=(1, 1, 1))
        if image_targets or date_targets:
            page.apply_redactions()

        for rect, tag, dir_ in image_targets:
            rotated = rotate_image_bytes(images_by_tag[tag], dir_)
            page.insert_image(rect, stream=rotated)
            placed[tag] += 1

        for rect, size, dir_ in date_targets:
            rotate = 90 if dir_[1] < 0 else (270 if dir_[1] > 0 else 0)
            point = pymupdf.Point(rect.x0, rect.y1)
            page.insert_text(point, get_display(date_str), fontsize=size, fontfile=FONT_PATH,
                              fontname=FONT_NAME, color=(0, 0, 0), rotate=rotate)
            placed["date_signature"] += 1

        if original_rotation != 0:
            page.set_rotation(original_rotation)

    out = BytesIO()
    doc.save(out)
    return out.getvalue(), placed


# ---------- Google Drive access ----------

def get_access_token():
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["GOOGLE_OAUTH_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    })
    resp.raise_for_status()
    return resp.json()["access_token"]


def drive_download(file_id, token):
    r = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
    )
    r.raise_for_status()
    return r.content


def drive_update_file(file_id, content_bytes, token):
    r = requests.patch(
        f"https://www.googleapis.com/upload/drive/v3/files/{file_id}",
        params={"uploadType": "media", "fields": "id, webViewLink, name"},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/pdf"},
        data=content_bytes,
    )
    r.raise_for_status()
    return r.json()


def decode_b64_image(data_url_or_b64):
    if not data_url_or_b64:
        return None
    if "," in data_url_or_b64[:60]:  # strip a data: URL prefix if present
        data_url_or_b64 = data_url_or_b64.split(",", 1)[1]
    return base64.b64decode(data_url_or_b64)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            file_id = body.get("fileId")
            if not file_id:
                self._json(400, {"ok": False, "error": "Missing fileId"})
                return

            sig1 = decode_b64_image(body.get("signature1"))
            sig2 = decode_b64_image(body.get("signature2")) or sig1
            stamp = decode_b64_image(body.get("stamp"))
            date_str = body.get("date") or ""

            images_by_tag = {}
            if sig1: images_by_tag["buyers_signature"] = sig1
            if sig2: images_by_tag["buyers_signature2"] = sig2
            if stamp: images_by_tag["gindi_stamp"] = stamp

            token = get_access_token()
            raw = drive_download(file_id, token)
            filled, placed = apply_to_pdf_bytes(raw, images_by_tag, date_str)
            updated = drive_update_file(file_id, filled, token)

            self._json(200, {
                "ok": True,
                "fileId": updated.get("id"),
                "name": updated.get("name"),
                "viewUrl": updated.get("webViewLink"),
                "placed": placed,
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
