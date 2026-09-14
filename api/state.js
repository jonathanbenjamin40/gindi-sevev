// /api/state.js
//
// GET  -> returns { units, cases, projects }
// POST -> body is { units, cases, projects }, overwrites the stored state

const { google } = require("googleapis");
const { getGoogleAuthClient } = require("./_googleAuth");

const SPREADSHEET_ID = process.env.CYCLE_SHEET_ID;
const SHEET_NAME = "state";
const CELL = "A1";
const EMPTY_STATE = { units: [], cases: [], projects: [] };

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuthClient() });
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
