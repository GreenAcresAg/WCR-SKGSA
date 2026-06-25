/**
 * Google Apps Script — Well Map Editor API
 *
 * SETUP:
 * 1. Create a Google Sheet, import wells.csv
 * 2. Add columns: review_status, review_notes, reviewed_latitude,
 *    reviewed_longitude, reviewed_by, reviewed_date
 * 3. Open Extensions > Apps Script, paste this code
 * 4. Replace SHEET_ID below with your sheet's ID
 *    (the long string in the Google Sheet URL between /d/ and /edit)
 * 5. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. Copy the deployment URL into editor.js (API_URL)
 */

const SHEET_ID = 'YOUR_SHEET_ID_HERE';
const SHEET_NAME = 'Sheet1';

/* ── GET: return all wells as JSON ────────────────────── */

function doGet(e) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const obj = {};
      headers.forEach((h, j) => {
        obj[h] = data[i][j];
      });
      rows.push(obj);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: rows }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ── POST: update a well by WCRNumber ─────────────────── */

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    const wcrCol = headers.indexOf('WCRNumber');
    if (wcrCol === -1) throw new Error('WCRNumber column not found');

    // Ensure review columns exist
    const reviewCols = [
      'review_status', 'review_notes',
      'reviewed_latitude', 'reviewed_longitude',
      'reviewed_by', 'reviewed_date',
      'zone_classification', 'screen_intervals'
    ];
    reviewCols.forEach(col => {
      if (headers.indexOf(col) === -1) {
        headers.push(col);
        sheet.getRange(1, headers.length).setValue(col);
      }
    });

    // Find the row
    let found = false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][wcrCol]) === String(payload.WCRNumber)) {
        // Update review fields
        const updates = {
          review_status: payload.review_status,
          review_notes: payload.review_notes,
          reviewed_latitude: payload.reviewed_latitude,
          reviewed_longitude: payload.reviewed_longitude,
          reviewed_by: payload.reviewed_by,
          reviewed_date: new Date().toISOString(),
          zone_classification: payload.zone_classification,
          screen_intervals: payload.screen_intervals,
        };

        Object.keys(updates).forEach(key => {
          if (updates[key] !== undefined && updates[key] !== null) {
            const col = headers.indexOf(key);
            if (col !== -1) {
              sheet.getRange(i + 1, col + 1).setValue(updates[key]);
            }
          }
        });

        found = true;
        break;
      }
    }

    if (!found) throw new Error('WCR ' + payload.WCRNumber + ' not found');

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
