// /api/_googleAuth.js
//
// Shared auth helper — used by state.js, upload-account-status.js, and
// api/cron/cycle-alerts.js. Authenticates as YOUR Google account via OAuth2
// (Client ID + Client Secret + a long-lived Refresh Token), instead of a
// service account JSON key.

const { google } = require("googleapis");

function getGoogleAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });
  return oAuth2Client;
}

module.exports = { getGoogleAuthClient };
