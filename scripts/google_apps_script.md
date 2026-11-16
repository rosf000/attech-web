# 宏威應用材料 ATTech 官網需求紀錄自動化腳本 (Google Apps Script)

本腳本部署於 Google 試算表（Google Apps Script），用於接收官網「詳細需求 / 索樣表單」送出之資料，並依 **13 欄標準規格** 同步記錄至 Google 試算表，同時自動將表單 PDF 歸檔至雲端硬碟。

---

## 13 欄標準表頭規格

```csv
填表日期,客戶,產品,詢問內容,送樣,報價,負責人,聯絡人,信箱,電話,傳真,地址,備註
```

> **跨國電話與號碼防呆處理**：
> 包含國碼之跨國號碼（如 `+86...`、`(+86)...`）或以 `0` 開頭的手機/市話（如 `09...`、`02...`），腳本會自動補上純文字前綴 `'`，確保 Google 試算表不會將其誤判為公式（產生 `#ERROR!`）或自動截除開頭的 `0`。

---

## Google Apps Script 程式碼

```javascript
// ==========================================
// 宏威應用材料 ATTech 官網需求紀錄自動化腳本
// ==========================================

// 【PDF 存放位置設定】
// 1. 留空 ""（推薦）：自動於試算表同層建立「官網申請單PDF」資料夾
// 2. 指定資料夾：將雲端資料夾網址最後面的 ID 填入引號中（例如："1AbC...XyZ"）
var TARGET_FOLDER_ID = "";

/**
 * 安全處理電話與傳真文字，防止跨國號碼 (+86 / +886) 被 Google 試算表誤判為公式，
 * 或開頭 0 (如 09xx / 02-xx) 被自動當成數值抹除。
 */
function sanitizePhoneText(val) {
  if (val === null || val === undefined) return "";
  var str = String(val).trim();
  if (!str) return "";
  // 若開頭帶有 +、=、- 或以 0 開頭的純數字串，加上單引號 "'" 強制 Google Sheet 視為純文字顯示
  if (/^[+=\-@]/.test(str) || /^0\d+/.test(str)) {
    return "'" + str;
  }
  return str;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);

    // 1. 若有傳入 PDF，自動存入 Google 雲端硬碟
    var pdfUrl = "";
    var driveErrorMsg = "";
    if (data.pdfBase64) {
      try {
        var decoded = Utilities.base64Decode(data.pdfBase64);
        var blob = Utilities.newBlob(decoded, "application/pdf", data.pdfFileName || "申請單.pdf");

        var pdfFolder;
        if (TARGET_FOLDER_ID && TARGET_FOLDER_ID.trim() !== "") {
          pdfFolder = DriveApp.getFolderById(TARGET_FOLDER_ID.trim());
        } else {
          var ssFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
          var parentFolders = ssFile.getParents();
          var targetFolder = parentFolders.hasNext() ? parentFolders.next() : DriveApp.getRootFolder();
          var folderIter = targetFolder.getFoldersByName("官網申請單PDF");
          pdfFolder = folderIter.hasNext() ? folderIter.next() : targetFolder.createFolder("官網申請單PDF");
        }

        var file = pdfFolder.createFile(blob);
        // 【關鍵防護】先取得雲端硬碟網址，確保連結不遺失
        pdfUrl = file.getUrl();

        // 嘗試開放知道連結者皆可檢視（若企業網域政策禁止外部共用，自動忽略不中斷）
        try {
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        } catch (shareErr) {
          console.warn("無法設為完全公開（受企業政策保護，內部同仁仍可檢視）: " + shareErr);
        }
      } catch (driveErr) {
        driveErrorMsg = driveErr.toString();
        console.error("雲端存檔錯誤: " + driveErr);
      }
    }

    // 2. 處理「產品」超連結：若有 PDF 連結，透過 HYPERLINK 函式包裝
    var rawSampleReq = data.sampleReq || "";
    var sampleReqDisplay = rawSampleReq;
    if (pdfUrl) {
      var safeLabel = (rawSampleReq || "查看PDF申請單").replace(/"/g, '""').replace(/\r?\n/g, ' ');
      sampleReqDisplay = '=HYPERLINK("' + pdfUrl + '", "' + safeLabel + '")';
    }

    // 3. 依據 13 欄標準格式寫入最新一列
    // 欄位順序：填表日期, 客戶, 產品, 詢問內容, 送樣, 報價, 負責人, 聯絡人, 信箱, 電話, 傳真, 地址, 備註
    sheet.appendRow([
      data.applyDate || Utilities.formatDate(new Date(), "GMT+8", "yyyy/MM/dd"), // 1. 填表日期
      data.company || "",                                                      // 2. 客戶
      sampleReqDisplay,                                                        // 3. 產品 (含 PDF 連結)
      data.remarks || "",                                                      // 4. 詢問內容
      data.sampleSent || "",                                                   // 5. 送樣
      data.quoted || "",                                                       // 6. 報價
      data.owner || "",                                                        // 7. 負責人
      data.contact || "",                                                      // 8. 聯絡人
      data.email || "",                                                        // 9. 信箱
      sanitizePhoneText(data.phone || data.mobile),                            // 10. 電話 (支援跨國號碼格式)
      sanitizePhoneText(data.fax),                                             // 11. 傳真
      data.address || "",                                                      // 12. 地址
      data.internalNote || ""                                                  // 13. 備註
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({
        result: "success",
        pdfUrl: pdfUrl,
        sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
        driveError: driveErrorMsg
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: "error", error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// 輔助函式：若試算表第一列尚未設置或需要升級，可於 Apps Script 編輯器執行此函式自動填入標準 13 欄表頭並凍結首列
function setupSheetHeaders() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = [
    '填表日期', '客戶', '產品', '詢問內容', '送樣', '報價', 
    '負責人', '聯絡人', '信箱', '電話', '傳真', '地址', '備註'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

// 執行此函式可一次性取得雲端硬碟「完整建立資料夾與檔案」權限
function authorizeDrive() {
  var test = DriveApp.getRootFolder().createFolder("權限授權驗證");
  test.setTrashed(true); // 驗證完成後自動刪除
}
```

---

## 部署注意事項
1. 程式碼貼入 Google Apps Script 編輯器後，點擊「儲存」。
2. 若表頭尚未更新為 13 欄，可在下拉選單選擇 `setupSheetHeaders` 點擊「執行」，即可自動設定表頭。
3. 部署時請務必點擊 **「部署」➜「管理部署作業」➜ 點擊鉛筆圖示「編輯」➜「版本」切換為「新版本」➜ 點擊「部署」**，確保 Webhook 啟用最新程式碼。
