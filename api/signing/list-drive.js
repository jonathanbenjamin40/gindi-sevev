// /api/signing/list-drive.js
//
// Powers the "חיתום" screen's folder browser.
//
// GET /api/signing/list-drive               -> folders directly under the
//   root signing folder (env SIGNING_ROOT_FOLDER_ID)
// GET /api/signing/list-drive?folderId=XXX   -> subfolders AND .pdf files
//   inside that specific folder (one apartment's document set)

const { google } = require("googleapis");
const { getGoogleAuthClient } = require("../_googleAuth");

const ROOT_FOLDER_ID = process.env.SIGNING_ROOT_FOLDER_ID;
const PDF_MIME = "application/pdf";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function getDriveClient() {
  return google.drive({ version: "v3", auth: getGoogleAuthClient() });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const drive = getDriveClient();
  const folderId = req.query.folderId || ROOT_FOLDER_ID;
  if (!folderId) {
    return res.status(400).json({ ok: false, error: "No folder configured (SIGNING_ROOT_FOLDER_ID) and none provided" });
  }

  try {
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, webViewLink)",
      orderBy: "name",
      pageSize: 200,
    });
    const files = result.data.files || [];
    const folders = files.filter((f) => f.mimeType === FOLDER_MIME);
    const allPdfs = files.filter((f) => f.mimeType === PDF_MIME);
    // The merged output from a previous run ("<folder> - מלא וחתום.pdf") is a
    // result, not a source — keep it out of the fillable list so re-running
    // the fill doesn't try to process its own previous output.
    const documents = allPdfs.filter((f) => f.name.indexOf("מלא וחתום") === -1);
    const previousOutputs = allPdfs.filter((f) => f.name.indexOf("מלא וחתום") !== -1);
    res.status(200).json({ ok: true, folderId, folders, documents, previousOutputs });
  } catch (err) {
    res.status(502).json({ ok: false, error: "Drive list failed", detail: String(err) });
  }
};
