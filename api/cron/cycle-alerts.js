// /api/cron/cycle-alerts.js
//
// Runs on a schedule (see vercel.json). On every run it:
//   1. Reads all rows from the "תיקים בסבב" sheet.
//   2. Rule A — "new contract entered the cycle": openedAt is within the last
//      run window and no alert has been sent yet -> email the distribution list.
//   3. Rule B — "day 8 without closing": 8+ days since openedAt, status is not
//      "closed", and no day-8 alert sent yet -> email the distribution list
//      with the station(s) the case is currently waiting on.
//   4. Writes the two "sent" flags back to the sheet so nothing is emailed twice.
//
// Nothing here runs unless it's deployed to Vercel with the env vars below set,
// and the Google Sheet exists with the column headers described in SETUP.md.

const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { getGoogleAuthClient } = require("../_googleAuth");

// ---- Config -----------------------------------------------------------

const SPREADSHEET_ID = process.env.CYCLE_SHEET_ID;
const SHEET_NAME = "תיקים בסבב";
const CYCLE_LENGTH_DAYS = 10;
const DAY8_THRESHOLD_DAYS = 8;
const RUN_WINDOW_MINUTES = 20; // must be >= the cron interval in vercel.json

// Distribution list for both rules. Split from a comma-separated env var so
// you can change recipients from the Vercel dashboard without touching code.
const DISTRIBUTION_LIST = (process.env.ALERT_RECIPIENTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Mirrors the 10 stations defined in the portal (checkStages), for readable
// email text. Keep this in sync if the station list changes.
const STATION_LABELS = [
  "רכזת חוזים · דיווח למשרד השיכון",
  "דיירים · הזנת נתוני הסכם ותוספות",
  "מחלקת דיירים · הזנת תוספות ופנקס שוברים",
  'סמנכ"לית שירות ודיירים · אישור שינויים',
  "הנהלת חשבונות · בדיקת נתוני משכנתא",
  "חשבים · בדיקת נספח תשלומים",
  'סמנכ"ל כספים · אישור סופי של ההסכם',
  'מנכ"ל · חתימה סופית על החוזה',
  'סמנכ"לית שירות ודיירים · הפצת החוזה ובקרה אחרונה',
];

// Column order in the sheet — must match SETUP.md exactly.
const COLUMNS = [
  "id", "proj", "unit", "client", "checkCur", "status",
  "openedAt", "stationEnteredAt", "docPath",
  "newAlertSent", "day8AlertSent",
];

// ---- Google Sheets helpers ---------------------------------------------

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuthClient() });
}

async function readRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`, // row 1 is headers
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => {
    const obj = { _rowNumber: i + 2 }; // +2: header row + 1-indexing
    COLUMNS.forEach((col, idx) => { obj[col] = row[idx] || ""; });
    return obj;
  });
}

async function writeFlags(sheets, rowNumber, { newAlertSent, day8AlertSent }) {
  // Columns J and K are newAlertSent / day8AlertSent — adjust if you reorder COLUMNS.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!J${rowNumber}:K${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newAlertSent, day8AlertSent]] },
  });
}

// ---- Mailer -------------------------------------------------------------

function getTransport() {
  // Gmail + App Password. To switch to Resend later, replace this function's
  // body with a fetch() call to Resend's API — the rest of the file doesn't change.
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function sendMail(transport, subject, html) {
  if (DISTRIBUTION_LIST.length === 0) return;
  await transport.sendMail({
    from: `"פורטל סבב בדיקות — גינדי" <${process.env.GMAIL_USER}>`,
    to: DISTRIBUTION_LIST.join(","),
    subject,
    html,
  });
}

// ---- Rules ----------------------------------------------------------------

function daysSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function minutesSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60);
}

// ---- Handler ----------------------------------------------------------

module.exports = async function handler(req, res) {
  // Vercel Cron calls this with a secret header — reject anything else so the
  // endpoint can't be triggered by a random visitor hitting the URL.
  if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }

  const sheets = getSheetsClient();
  const transport = getTransport();
  const rows = await readRows(sheets);

  for (const r of rows) {
    // Rule A — new contract entered the cycle
    if (!r.newAlertSent && minutesSince(r.openedAt) <= RUN_WINDOW_MINUTES) {
      await sendMail(
        transport,
        `חוזה חדש נכנס לסבב — ${r.id}`,
        `<div dir="rtl" style="font-family:sans-serif">
           <p>תיק <b>${r.id}</b> · ${r.proj} · ${r.unit} · לקוח: ${r.client} נכנס לסבב הבדיקות.</p>
         </div>`
      );
      await writeFlags(sheets, r._rowNumber, { newAlertSent: "TRUE", day8AlertSent: r.day8AlertSent || "" });
    }

    // Rule B — day 8 of a 10-day cycle and still not closed
    const age = daysSince(r.openedAt);
    if (!r.day8AlertSent && r.status !== "closed" && age >= DAY8_THRESHOLD_DAYS) {
      const stationLabel = STATION_LABELS[Number(r.checkCur)] || "לא ידוע";
      await sendMail(
        transport,
        `חוזה לא סיים סבב ביום ה-8 — ${r.id}`,
        `<div dir="rtl" style="font-family:sans-serif">
           <p>תיק <b>${r.id}</b> · ${r.proj} · ${r.unit} · לקוח: ${r.client} עדיין לא סיים
              את הסבב (מתוך ${CYCLE_LENGTH_DAYS} ימים).</p>
           <p>ממתין כרגע בתחנה: <b>${stationLabel}</b>${r.status === "returned" ? " (התיק הוחזר לתיקון)" : ""}</p>
         </div>`
      );
      await writeFlags(sheets, r._rowNumber, { newAlertSent: r.newAlertSent || "", day8AlertSent: "TRUE" });
    }
  }

  res.status(200).json({ ok: true, checked: rows.length });
};
