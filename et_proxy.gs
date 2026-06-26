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
 *
 * Usage (GET):
 *   ?lng=-119.81&lat=36.28&start=2023-01-01&end=2023-12-31
 */

const OPENET_API_KEY = 'YOUR_OPENET_API_KEY_HERE';
const OPENET_BASE = 'https://openet-api.org';

function doGet(e) {
  try {
    var lng = e.parameter.lng;
    var lat = e.parameter.lat;
    var start = e.parameter.start;
    var end = e.parameter.end;

    // Status check if no params
    if (!lng || !lat) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'ok', message: 'OpenET proxy running. Use ?lng=&lat=&start=&end=' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var body = {
      date_range: [start, end],
      interval: 'monthly',
      geometry: [parseFloat(lng), parseFloat(lat)],
      model: 'Ensemble',
      variable: 'ET',
      reference_et: 'cimis',
      units: 'mm',
      file_format: 'JSON'
    };

    var response = UrlFetchApp.fetch(OPENET_BASE + '/raster/timeseries/point', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': OPENET_API_KEY,
        'accept': 'application/json'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    var status = response.getResponseCode();
    var text = response.getContentText();

    return ContentService
      .createTextOutput(JSON.stringify({
        success: status >= 200 && status < 300,
        status: status,
        data: JSON.parse(text)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
