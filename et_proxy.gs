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
 * Supports two modes:
 *   GET  ?lng=&lat=&start=&end=          → point query
 *   GET  ?geom=<GeoJSON>&start=&end=     → polygon query (field average)
 */

var OPENET_API_KEY = 'YOUR_OPENET_API_KEY_HERE';
var OPENET_BASE = 'https://openet-api.org';

function doGet(e) {
  try {
    var geom = e.parameter.geom;
    var lng = e.parameter.lng;
    var lat = e.parameter.lat;
    var start = e.parameter.start;
    var end = e.parameter.end;

    // Status check if no params
    if (!start && !geom && !lng) {
      return jsonOut({ status: 'ok', message: 'OpenET proxy running.' });
    }

    var endpoint, body;

    if (geom) {
      // Polygon mode — field-averaged ET
      var geometry = JSON.parse(geom);
      endpoint = '/raster/timeseries/polygon';
      body = {
        date_range: [start, end],
        interval: 'monthly',
        geometry: geometry,
        model: 'Ensemble',
        variable: 'ET',
        reference_et: 'cimis',
        units: 'mm',
        file_format: 'JSON',
        reducer: 'mean'
      };
    } else {
      // Point mode
      endpoint = '/raster/timeseries/point';
      body = {
        date_range: [start, end],
        interval: 'monthly',
        geometry: [parseFloat(lng), parseFloat(lat)],
        model: 'Ensemble',
        variable: 'ET',
        reference_et: 'cimis',
        units: 'mm',
        file_format: 'JSON'
      };
    }

    var response = UrlFetchApp.fetch(OPENET_BASE + endpoint, {
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

    return jsonOut({
      success: status >= 200 && status < 300,
      status: status,
      data: JSON.parse(text)
    });
  } catch (err) {
    return jsonOut({ success: false, error: err.message });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
