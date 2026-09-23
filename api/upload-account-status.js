// /api/upload-account-status.js
//
// Called from the portal's browser when the "הנהלת חשבונות" station uploads
// an account-status file (screenshot/PDF) for a specific case.
//
// Request body (JSON): { caseId, filename, mimeType, contentBase64 }
// Response (JSON):      { ok:true, fileId, viewUrl }
//
// The returned viewUrl is what gets written into the case's accountStatusUrl
// field in the sheet — the same field the frontend already reads to show the
// "מצב חשבון" button. Every filename is prefixed with the case ID so the
// file can never be confused with another apartment's file.

const { google } = require("googleapis");
const { getGoogleAuthClient } = require("./_googleAuth");

const FOLDER_ID = process.env.DRIVE_ACCOUNT_STATUS_FOLDER_ID; // 1fPqtbPgV2VaN3jUSWgWYPRZfweH5mFvb

function getDriveClient() {
  // Same OAuth2 client used for Sheets — the refresh token already carries
  // both the spreadsheets and drive scopes granted in the OAuth Playground.
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
  // Basic guard against path/ID injection in the case ID before it goes into a filename.
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
      body: Buffer.from(contentBase64, "base64"),
    },
    fields: "id, webViewLink",
  });

  // Anyone in the organization with the link can view — adjust to a specific
  // domain restriction if Gindi's Drive admin prefers that over "anyone with link".
  await drive.permissions.create({
    fileId: created.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  res.status(200).json({ ok: true, fileId: created.data.id, viewUrl: created.data.webViewLink });
};
