// /api/cron/cycle-alerts.js

const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { getGoogleAuthClient } = require("../_googleAuth");

const SPREADSHEET_ID = process.env.CYCLE_SHEET_ID;
const SHEET_NAME = "תיקים בסבב";
const CYCLE_LENGTH_DAYS = 10;
const DAY8_THRESHOLD_DAYS = 8;
const RUN_WINDOW_MINUTES = 20;

const DISTRIBUTION_LIST = (process.env.ALERT_RECIPIENTS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

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

const COLUMNS = ["id","proj","unit","client","checkCur","status","openedAt","stationEnteredAt","docPath","newAlertSent","day8AlertSent"];

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuthClient() });
}

async function readRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => {
    const obj = { _rowNumber: i + 2 };
    COLUMNS.forEach((col, idx) => { obj[col] = row[idx] || ""; });
    return obj;
  });
}

async function writeFlags(sheets, rowNumber, { newAlertSent, day8AlertSent }) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!J${rowNumber}:K${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newAlertSent, day8AlertSent]] },
  });
}

function getTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function sendMail(transport, subject, html) {
  if (DISTRIBUTION_LIST.length === 0) return;
  await transport.sendMail({
    from: `"פורטל סבב בדיקות — גינדי" <${process.env.GMAIL_USER}>`,
    to: DISTRIBUTION_LIST.join(","),
    subject, html,
  });
}

function daysSince(isoDate) { return (Date.now() - new Date(isoDate).getTime()) / (1000*60*60*24); }
function minutesSince(isoDate) { return (Date.now() - new Date(isoDate).getTime()) / (1000*60); }

module.exports = async function handler(req, res) {
  if (req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }
  const sheets = getSheetsClient();
  const transport = getTransport();
  const rows = await readRows(sheets);

  for (const r of rows) {
    if (!r.newAlertSent && minutesSince(r.openedAt) <= RUN_WINDOW_MINUTES) {
      await sendMail(transport, `חוזה חדש נכנס לסבב — ${r.id}`,
        `<div dir="rtl" style="font-family:sans-serif"><p>תיק <b>${r.id}</b> · ${r.proj} · ${r.unit} · לקוח: ${r.client} נכנס לסבב הבדיקות.</p></div>`);
      await writeFlags(sheets, r._rowNumber, { newAlertSent: "TRUE", day8AlertSent: r.day8AlertSent || "" });
    }
    const age = daysSince(r.openedAt);
    if (!r.day8AlertSent && r.status !== "closed" && age >= DAY8_THRESHOLD_DAYS) {
      const stationLabel = STATION_LABELS[Number(r.checkCur)] || "לא ידוע";
      await sendMail(transport, `חוזה לא סיים סבב ביום ה-8 — ${r.id}`,
        `<div dir="rtl" style="font-family:sans-serif"><p>תיק <b>${r.id}</b> · ${r.proj} · ${r.unit} · לקוח: ${r.client} עדיין לא סיים את הסבב (מתוך ${CYCLE_LENGTH_DAYS} ימים).</p><p>ממתין כרגע בתחנה: <b>${stationLabel}</b>${r.status === "returned" ? " (התיק הוחזר לתיקון)" : ""}</p></div>`);
      await writeFlags(sheets, r._rowNumber, { newAlertSent: r.newAlertSent || "", day8AlertSent: "TRUE" });
    }
  }
  res.status(200).json({ ok: true, checked: rows.length });
};
