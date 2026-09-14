// /api/upload-account-status.js
//
// Request body (JSON): { caseId, filename, mimeType, contentBase64 }
// Response (JSON):      { ok:true, fileId, viewUrl }

const { google } = require("googleapis");
const { Readable } = require("stream");
const { getGoogleAuthClient } = require("./_googleAuth");

const FOLDER_ID = process.env.DRIVE_ACCOUNT_STATUS_FOLDER_ID;

function getDriveClient() {
  return google.drive({ version: "v3", auth: getGoogleAuthClient() });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const { caseId, filename, mimeType, contentBase64 } = req.body || {};
  if (!caseId || !filename || !mimeType || !contentBase64) {
    return res.status(400).json({ ok: false, error: "Missing caseId, filename, mimeType or contentBase64" });
  }
  if (!/^[A-Za-z0-9-]+$/.test(caseId)) {
    return res.status(400).json({ ok: false, error: "Invalid caseId" });
  }

  const drive = getDriveClient();
  const safeName = `${caseId}__${filename}`;

  const created = await drive.files.create({
    requestBody: {
      name: safeName,
      parents: [FOLDER_ID],
    },
    media: {
      mimeType,
      body: Readable.from(Buffer.from(contentBase64, "base64")),
    },
    fields: "id, webViewLink",
  });

  await drive.permissions.create({
    fileId: created.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  res.status(200).json({ ok: true, fileId: created.data.id, viewUrl: created.data.webViewLink });
};
