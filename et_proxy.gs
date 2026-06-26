/**
 * Google Apps Script — OpenET API Proxy
 *
 * SETUP:
 * 1. Go to https://script.google.com and create a new project
 * 2. Paste this code
 * 3. Replace OPENET_API_KEY below with your key from
 *    https://account.etdata.org/settings/api
 * 4. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the deployment URL into et.js (PROXY_URL)
 */

const OPENET_API_KEY = 'YOUR_OPENET_API_KEY_HERE';
const OPENET_BASE = 'https://openet-api.org';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const endpoint = payload.endpoint; // e.g. "/raster/timeseries/point"
    const body = payload.body;         // the actual OpenET request body

    if (!endpoint || !body) {
      throw new Error('Missing endpoint or body');
    }

    // Only allow specific endpoints
    const allowed = [
      '/raster/timeseries/point',
      '/raster/timeseries/polygon',
    ];
    if (allowed.indexOf(endpoint) === -1) {
      throw new Error('Endpoint not allowed: ' + endpoint);
    }

    const response = UrlFetchApp.fetch(OPENET_BASE + endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': OPENET_API_KEY,
        'accept': 'application/json',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });

    const status = response.getResponseCode();
    const text = response.getContentText();

    return ContentService
      .createTextOutput(JSON.stringify({
        success: status >= 200 && status < 300,
        status: status,
        data: JSON.parse(text),
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'OpenET proxy is running. Use POST.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
