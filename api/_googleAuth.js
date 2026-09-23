// /api/_googleAuth.js
//
// Shared auth helper — used by state.js, upload-account-status.js, and
// api/cron/cycle-alerts.js. Authenticates as YOUR Google account via OAuth2
// (Client ID + Client Secret + a long-lived Refresh Token), instead of a
// service account JSON key.
//
// Why: Jonathan's Google Cloud project is under a personal account, where
// Google's "Secure by Default" policy (iam.disableServiceAccountKeyCreation)
// blocks downloading service account keys, with no accessible Organization
// admin to lift it. OAuth2 client credentials are a completely different
// credential type and are not affected by that policy.
//
// Bonus side effect: since the code now authenticates AS your own Google
// account, you do NOT need to "share" the Sheet or Drive folder with any
// special service-account email — they're already yours.

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
