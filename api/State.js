// /api/state.js
//
// Persists the portal's entire in-browser state (unit inventory, cases in
// the cycle, and the project list) so it survives page reloads and new
// deployments — which is the whole point: right now everything lives only
// in the browser's memory and vanishes on refresh.
//
// Storage choice: ONE JSON blob in a single cell of a Google Sheet, not a
// normalized row-per-record sheet. This is a deliberate simplification for
// speed — it is NOT something you browse/edit like a normal spreadsheet.
// It solves data loss today; a normalized sheet (one row per apartment, one
// row per case) is a bigger follow-up project if you want to eyeball or
// hand-edit rows directly in Sheets.
//
// GET  -> returns { units, cases, projects }
// POST -> body is { units, cases, projects }, overwrites the stored state

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.CYCLE_SHEET_ID; // same spreadsheet already used for the email-alert cron
const SHEET_NAME = "state";
const CELL = "A1";
const EMPTY_STATE = { units: [], cases: [], projects: [] };

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

module.exports = async function handler(req, res) {
  const sheets = getSheetsClient();

  if (req.method === "GET") {
    try {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!${CELL}`,
      });
      const raw = result.data.values && result.data.values[0] && result.data.values[0][0];
      const state = raw ? JSON.parse(raw) : EMPTY_STATE;
      return res.status(200).json(state);
    } catch (err) {
      // First run: the "state" tab or cell doesn't exist yet — start empty
      // rather than erroring out the whole portal.
      return res.status(200).json(EMPTY_STATE);
    }
  }

  if (req.method === "POST") {
    const state = {
      units: (req.body && req.body.units) || [],
      cases: (req.body && req.body.cases) || [],
      projects: (req.body && req.body.projects) || [],
    };
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${CELL}`,
      valueInputOption: "RAW",
      requestBody: { values: [[JSON.stringify(state)]] },
    });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
};
