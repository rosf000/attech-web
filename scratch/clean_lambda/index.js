/**
 * ====================================================================
 * ATTech Materials - AWS Lambda 專用郵件與 PDF 生成 Handler (index.js)
 * ====================================================================
 */

const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const GOOGLE_SHEET_VIEW_URL = process.env.GOOGLE_SHEET_VIEW_URL || 'https://docs.google.com/spreadsheets/d/1rsS0tsO1kX9G0HPSBerrI9Jo8SerZRAzjTrMMPNYays/edit?gid=317142515#gid=317142515';

// 輔助函式：陣列轉換字串
function formatList(val) {
    if (Array.isArray(val)) {
        return val.length > 0 ? val.join('、') : '無';
    }
    return val || '無';
}

// 動態生成單頁 PDF 附件
function createStyledPDF(title, sections, companyName) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margins: { top: 20, bottom: 15, left: 28, right: 28 },
            bufferPages: true
        });

        let buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // 字型路徑 (支援 Lambda 環境)
        const regularFontPath = path.join(__dirname, 'fonts', 'NotoSansTC-Regular.ttf');
        const boldFontPath = path.join(__dirname, 'fonts', 'NotoSansTC-Bold.ttf');

        let fontRegular = 'Helvetica';
        let fontBold = 'Helvetica-Bold';

        if (fs.existsSync(regularFontPath)) {
            doc.registerFont('ChineseRegular', regularFontPath);
            fontRegular = 'ChineseRegular';
        }
        if (fs.existsSync(boldFontPath)) {
            doc.registerFont('ChineseBold', boldFontPath);
            fontBold = 'ChineseBold';
        } else if (fontRegular === 'ChineseRegular') {
            fontBold = 'ChineseRegular';
        }

        const pageWidth = doc.page.width - 56;
        const startX = 28;

        // Header 公司抬頭
        doc.font(fontBold).fontSize(14).fillColor('#0F2C59').text('宏威應用材料 ATTech Materials', startX, 22, { align: 'left' });
        doc.font(fontRegular).fontSize(8).fillColor('#475569').text('Discover The Link To Life | 40661 台中市北屯區廍子巷116號1樓 | TEL: +886-4-2239-8056', startX, 38, { align: 'left' });
        doc.moveTo(startX, 50).lineTo(startX + pageWidth, 50).strokeColor('#1E3A8A').lineWidth(1.5).stroke();

        // 表單大標題
        doc.y = 56;
        doc.font(fontBold).fontSize(12).fillColor('#1E3A8A').text(title, { align: 'center' });
        doc.moveDown(0.25);

        let totalRows = 0;
        sections.forEach(sec => {
            totalRows += (sec.rows ? sec.rows.length : 0);
        });

        // 版面最佳化：動態調整列高與字級，充實填滿 A4 頁面且嚴格保證單頁
        const isCompact = totalRows > 15;
        const baseRowHeight = isCompact ? 23 : 26;
        const fontSize = isCompact ? 9 : 9.5;
        const sectionHeaderHeight = isCompact ? 19 : 21;

        sections.forEach(section => {
            const secHeaderY = doc.y;
            doc.rect(startX, secHeaderY, pageWidth, sectionHeaderHeight).fill('#E2E8F0');
            doc.font(fontBold).fontSize(8.5).fillColor('#0F2C59').text(`  ${section.title}`, startX + 4, secHeaderY + 3.5);
            doc.y = secHeaderY + sectionHeaderHeight;

            section.rows.forEach(row => {
                const currentY = doc.y;
                const labelWidth = isCompact ? 120 : 130;
                const valueWidth = pageWidth - labelWidth;
                const textVal = String(row.value || '無');

                doc.font(fontRegular).fontSize(fontSize);
                const measuredHeight = doc.heightOfString(textVal, { width: valueWidth - 14 });
                const actualRowHeight = Math.max(baseRowHeight, Math.min(46, measuredHeight + 8));

                doc.rect(startX, currentY, labelWidth, actualRowHeight).fillAndStroke('#F8FAFC', '#CBD5E1');
                doc.rect(startX + labelWidth, currentY, valueWidth, actualRowHeight).fillAndStroke('#FFFFFF', '#CBD5E1');

                doc.font(fontBold).fontSize(fontSize).fillColor('#1E293B').text(row.label, startX + 7, currentY + 5, {
                    width: labelWidth - 12,
                    ellipsis: true
                });

                doc.font(fontRegular).fontSize(fontSize).fillColor('#334155').text(textVal, startX + labelWidth + 7, currentY + 5, {
                    width: valueWidth - 14,
                    height: actualRowHeight - 6,
                    ellipsis: true
                });

                doc.y = currentY + actualRowHeight;
            });

            doc.y += 6;
        });

        const currentDate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\u202f/g, ' ');
        const footerY = doc.page.height - 28;

        doc.moveTo(startX, footerY - 4).lineTo(startX + pageWidth, footerY - 4).strokeColor('#CBD5E1').lineWidth(0.5).stroke();
        doc.font(fontRegular).fontSize(7.5).fillColor('#64748B').text(`列印時間：${currentDate} | 宏威應用材料 Discover The Link To Life`, startX, footerY, { width: pageWidth, align: 'left', lineBreak: false });
        doc.font(fontRegular).fontSize(7.5).fillColor('#64748B').text(`第 1 頁 / 共 1 頁`, startX, footerY, { width: pageWidth, align: 'right', lineBreak: false });

        doc.end();
    });
}

// 60 秒防重複提交快取 (AWS Lambda 溫啟動跨請求防重)
const recentSubmissions = new Map();
const SUBMISSION_COOLDOWN_MS = 60 * 1000;

function cleanupOldSubmissions() {
    const now = Date.now();
    for (const [key, timestamp] of recentSubmissions.entries()) {
        if (now - timestamp > SUBMISSION_COOLDOWN_MS * 2) {
            recentSubmissions.delete(key);
        }
    }
}

// AWS Lambda 核心進入點
// 同步將需求紀錄寫入 Google 試算表（非同步發送）
async function appendToGoogleSheet(data, pdfBuffer, pdfFilename) {
    const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxvdFXsz57oSrdAVynVet9_v4VPqAp0ZedUsSYVY7awLXYIbl8Dlgn__kgU-qW9p1nHQw/exec';
    if (!webhookUrl) return;

    try {
        const payload = {
            applyDate: data.applyDate || new Date().toISOString().split('T')[0].replace(/-/g, '/'),
            company: data.company || '',
            contact: data.contact || '',
            email: data.email || '',
            sampleReq: data.sampleReq || (Array.isArray(data.sampleItems) ? data.sampleItems.map(s => s.name + (s.qty ? ` (${s.qty})` : '')).join('；') : (data.sample || '')),
            remarks: data.remarks || data.message || '', // "詢問內容"填入詳細表單的"備註/其他說明"
            sampleSent: '',
            quoted: '',
            owner: '',
            phone: data.phone || data.mobile || '',
            fax: data.fax || '',
            address: data.address || '',
            internalNote: '',
            pdfBase64: pdfBuffer ? Buffer.from(pdfBuffer).toString('base64') : '',
            pdfFileName: pdfFilename || `${data.company || '客戶'}_樣品申請單.pdf`
        };

        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const resJson = await res.json().catch(() => ({}));
        console.log(`[GoogleSheet Lambda] Synced row: ${payload.company} (HTTP ${res.status}), pdfUrl: ${resJson.pdfUrl || 'none'}`);
        return resJson;
    } catch (err) {
        console.error('[GoogleSheet Lambda Error]:', err.message);
    }
}

// AWS Lambda 核心進入點
exports.handler = async (event, context) => {
    // 跨域 CORS 標頭
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
    };

    // 處理 OPTIONS 預檢請求
    if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }

    try {
        let data = {};
        if (event.body) {
            const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
            data = typeof bodyStr === 'string' ? JSON.parse(bodyStr) : bodyStr;
        } else if (typeof event === 'object' && event !== null) {
            // 兼容 AWS Lambda 控制台直接以 JSON 格式觸發測試事件
            data = event;
        }

        const { company, contact, email, type } = data;

        if (!company || !contact || !email) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    success: false,
                    message: '請填寫必填欄位（公司名稱、聯絡人、電子信箱）'
                })
            };
        }

        // 短時間去重指紋 (避免快速連點或重複發信)
        const dedupSample = (data.sample || data.sampleReq || (Array.isArray(data.sampleItems) ? data.sampleItems.map(s => s.name).join(';') : '') || data.message || '').trim().toLowerCase();
        const dedupKey = `${(email || '').trim().toLowerCase()}###${(company || '').trim().toLowerCase()}###${dedupSample}`;

        const lastSeen = recentSubmissions.get(dedupKey);
        const now = Date.now();
        if (lastSeen && (now - lastSeen < SUBMISSION_COOLDOWN_MS)) {
            const waitSeconds = Math.ceil((SUBMISSION_COOLDOWN_MS - (now - lastSeen)) / 1000);
            console.log(`[DEDUP] 偵測到 ${email} (${company}) 於 ${60 - waitSeconds}s 前已送出相同需求，已安全攔截重複郵件`);
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    success: true,
                    isDuplicate: true,
                    message: `您的需求表單已成功送出並在處理中，專員將儘速與您聯繫（請稍候 ${waitSeconds} 秒後再試，系統已自動為您合併）。`
                })
            };
        }

        cleanupOldSubmissions();
        recentSubmissions.set(dedupKey, now);

        const isQuickMode = (type === '快速詢價' || !data.appFields);
        let subject = `【官網需求單】${company} - ${contact}（${isQuickMode ? '快速樣品申請' : '詳細樣品申請與技術評估'}）`;
        let textContent = '';
        let htmlContent = '';
        let attachments = [];
        let pdfSections = [];

        if (isQuickMode) {
            const applyDate = (data.applyDate || new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })).replace(/-/g, '/');
            const mobile = data.mobile || data.phone || data.tel || '未提供';
            const sample = data.sample || '未提供';
            const address = data.address || '未提供';
            const message = data.message || '無';

            textContent = `
【宏威應用材料 - 指定樣品 / 快速詢價需求單】
--------------------------------------------------
填表日期：${applyDate}
公司名稱：${company}
聯絡人（職稱）：${contact}
電子信箱：${email}
聯絡電話 / 手機：${mobile}
指定索樣產品與數量：${sample}
樣品寄送地址：${address}
備註 / 詢問內容：${message}
--------------------------------------------------
時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
            `;

            htmlContent = `
            <div style="font-family: Arial, 'Microsoft JhengHei', sans-serif; max-width: 650px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b; background-color: #ffffff;">
                <div style="border-bottom: 2px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 16px;">
                    <h2 style="color: #0f2c59; margin: 0 0 4px 0; font-size: 20px;">宏威應用材料 ATTech Materials</h2>
                    <p style="color: #1e3a8a; font-weight: bold; margin: 0; font-size: 15px;">指定樣品 / 快速詢價表單 (簡易樣品申請單)</p>
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 16px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; width: 150px; color: #475569; background-color: #f8fafc;">填表日期</td><td style="padding: 8px;">${applyDate}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">公司名稱</td><td style="padding: 8px;">${company}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">聯絡人（職稱）</td><td style="padding: 8px;">${contact}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">電子信箱</td><td style="padding: 8px;"><a href="mailto:${email}" style="color: #1e3a8a; text-decoration: none;">${email}</a></td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">聯絡電話 / 手機</td><td style="padding: 8px;">${mobile}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #1e3a8a; background-color: #eff6ff;">索樣產品與數量</td><td style="padding: 8px; font-weight: bold; color: #1e3a8a;">${sample}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">樣品寄送地址</td><td style="padding: 8px;">${address}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569; background-color: #f8fafc;">備註 / 詢問內容</td><td style="padding: 8px; white-space: pre-wrap;">${message}</td></tr>
                </table>
                <div style="font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    ※ 此郵件由 ATTech 官網系統自動發出，PDF 正式申請單已作為附件附加。
                </div>
            </div>
            `;

            pdfSections = [
                {
                    title: '基本聯絡與索樣資訊',
                    rows: [
                        { label: '填表日期', value: applyDate },
                        { label: '公司名稱', value: company },
                        { label: '聯絡人（職稱）', value: contact },
                        { label: '電子信箱', value: email },
                        { label: '聯絡電話 / 手機', value: mobile },
                        { label: '指定索樣產品與數量', value: sample },
                        { label: '樣品寄送地址', value: address },
                        { label: '備註 / 詢問內容', value: message }
                    ]
                }
            ];
        } else {
            const applyDate = (data.applyDate || data.detail_date || new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })).replace(/-/g, '/');
            const tel = data.tel || data.phone || '未提供';
            const mobile = data.mobile || '未提供';
            const fax = data.fax || '未提供';
            const address = data.address || '未提供';

            // 處理應用領域（可含其他）
            let appFieldsStr = formatList(data.appFields);
            const otherAppDomain = (data.otherAppDomain || data.otherAppField || '').trim();
            if (otherAppDomain && otherAppDomain !== '無') {
                appFieldsStr = (appFieldsStr !== '無' && appFieldsStr !== '') ? `${appFieldsStr}（其他: ${otherAppDomain}）` : otherAppDomain;
            }

            const functions = formatList(data.functions);
            const otherFunc = (data.otherFunc || '').trim();
            const fullFunc = (otherFunc && otherFunc !== '無') ? `${functions}（其他: ${otherFunc}）` : functions;

            const systems = formatList(data.systems);
            const compType = data.compType || '未指定';
            const appType = data.appType || '未指定';

            // 底材類型（可含其他）
            let substratesStr = formatList(data.substrates);
            const otherSubstrate = (data.otherSubstrate || '').trim();
            if (otherSubstrate && otherSubstrate !== '無') {
                substratesStr = (substratesStr !== '無' && substratesStr !== '') ? `${substratesStr}（其它: ${otherSubstrate}）` : otherSubstrate;
            }

            const filmThick = data.filmThick ? `${data.filmThick} µm` : '未填寫';
            const isAirDry = (data.cureMethod === '風乾' || data.cureMethod === '常溫風乾' || data.noBake === '是' || data.noBake === true);
            const rawTemp = (data.bakeTemp || '').trim();
            const rawTime = (data.bakeTime || '').trim();
            const hasTemp = rawTemp && rawTemp !== '未填寫' && rawTemp !== '無 (風乾)' && rawTemp !== '無';
            const hasTime = rawTime && rawTime !== '未填寫' && rawTime !== '無 (風乾)' && rawTime !== '無';

            let cureCondition = '';
            if (isAirDry) {
                cureCondition = '常溫風乾（不烘烤）';
            } else if (hasTemp && hasTime) {
                cureCondition = `烘烤（溫度: ${rawTemp} | 時間: ${rawTime}）`;
            } else if (hasTemp) {
                cureCondition = `烘烤（溫度: ${rawTemp} | 時間: 未填寫）`;
            } else if (hasTime) {
                cureCondition = `烘烤（溫度: 未填寫 | 時間: ${rawTime}）`;
            } else if (data.cureMethod === '烘烤' || data.noBake === '否') {
                cureCondition = '烘烤（溫度/時間: 未指定）';
            } else {
                cureCondition = '未指定';
            }

            // 樹脂系統（可含其他）
            let resinsStr = formatList(data.resins);
            const otherResin = (data.otherResin || '').trim();
            if (otherResin && otherResin !== '無') {
                resinsStr = (resinsStr !== '無' && resinsStr !== '') ? `${resinsStr}（其他: ${otherResin}）` : otherResin;
            }

            const restricted = data.restricted || '無';

            // 索樣產品資訊（支援結構化項目或字串）
            let sampleReq = data.sampleReq || '未填寫';
            if (Array.isArray(data.sampleItems) && data.sampleItems.length > 0) {
                const items = data.sampleItems
                    .filter(it => it && it.name && it.name.trim())
                    .map(it => it.qty ? `${it.name.trim()}（數量: ${it.qty.trim()}）` : it.name.trim());
                if (items.length > 0) {
                    sampleReq = items.join('；');
                }
            }

            const docs = formatList(data.docs);
            const pastSamples = data.pastSamples || '無';
            const remarks = data.remarks || '無';

            textContent = `
【宏威應用材料 - 詳細樣品申請與技術評估單】
--------------------------------------------------
A. 基本聯絡資訊
填表日期：${applyDate}
公司名稱：${company}
聯絡人（職稱）：${contact}
電子信箱：${email}
電話及分機：${tel}
手機號碼：${mobile}
傳真號碼：${fax}
寄送地址：${address}

B. 應用需求
應用領域：${appFieldsStr}
功能需求：${fullFunc}
系統型態：${systems}
組份 / 外觀：${compType} / ${appType}

C. 基本資訊與規格
底材類型：${substratesStr}
乾膜厚度：${filmThick}
乾燥固化條件：${cureCondition}
樹脂系統：${resinsStr}
限用物質：${restricted}
索樣產品資訊：${sampleReq}
需求文件：${docs}

D & E. 曾測試紀錄與備註
曾試過的相關樣品：${pastSamples}
備註 / 其他說明：${remarks}
--------------------------------------------------
時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
            `;

            htmlContent = `
            <div style="font-family: Arial, 'Microsoft JhengHei', sans-serif; max-width: 700px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b; background-color: #ffffff;">
                <div style="border-bottom: 2px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 16px;">
                    <h2 style="color: #0f2c59; margin: 0 0 4px 0; font-size: 20px;">宏威應用材料 ATTech Materials</h2>
                    <p style="color: #1e3a8a; font-weight: bold; margin: 0; font-size: 15px;">詳細應用需求評估單 (完整樣品申請單)</p>
                </div>

                <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;">
                    <div style="font-weight: bold; color: #166534; font-size: 14px; margin-bottom: 4px;">📊 雲端自動同步提醒</div>
                    <div style="font-size: 12px; color: #15803d; margin-bottom: 10px;">本筆需求已即時自動歸檔至 Google 需求紀錄總表，PDF 申請單已同步存入雲端硬碟。</div>
                    <div>
                        <a href="${GOOGLE_SHEET_VIEW_URL}" target="_blank" style="display: inline-block; background-color: #16a34a; color: #ffffff; text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-right: 8px;">📊 開啟 Google 需求總表 ➔</a>
                        {{PDF_ACTION_BUTTON}}
                    </div>
                </div>
                
                <h3 style="color: #1e3a8a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 16px;">A. 基本聯絡資訊</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">填表日期：</td><td style="padding: 6px;">${applyDate}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">公司名稱：</td><td style="padding: 6px;">${company}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">聯絡人（職稱）：</td><td style="padding: 6px;">${contact}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">電子信箱：</td><td style="padding: 6px;"><a href="mailto:${email}" style="color: #1e3a8a;">${email}</a></td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">電話及分機：</td><td style="padding: 6px;">${tel}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">手機號碼：</td><td style="padding: 6px;">${mobile}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">傳真號碼：</td><td style="padding: 6px;">${fax}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">樣品寄送地址：</td><td style="padding: 6px;">${address}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 16px;">B. 應用需求與系統</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">應用領域：</td><td style="padding: 6px;">${appFieldsStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">功能需求：</td><td style="padding: 6px;">${fullFunc}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">系統型態：</td><td style="padding: 6px;">${systems}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">組份 / 外觀：</td><td style="padding: 6px;">${compType} / ${appType}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 16px;">C. 基本規格與限制</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">底材類型：</td><td style="padding: 6px;">${substratesStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾膜厚度：</td><td style="padding: 6px;">${filmThick}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾燥固化條件：</td><td style="padding: 6px;">${cureCondition}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">樹脂系統：</td><td style="padding: 6px;">${resinsStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">限用物質：</td><td style="padding: 6px;">${restricted}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #1e3a8a; background-color: #eff6ff;">索樣產品資訊：</td><td style="padding: 6px; font-weight: bold; color: #1e3a8a;">${sampleReq}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">需求文件：</td><td style="padding: 6px;">${docs}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; font-size: 14px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 16px;">D & E. 曾測試紀錄與備註</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">曾試過樣品：</td><td style="padding: 6px;">${pastSamples}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">備註 / 其他說明：</td><td style="padding: 6px; white-space: pre-wrap;">${remarks}</td></tr>
                </table>

                <div style="font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    ※ 此郵件由 ATTech 官網系統自動發出，PDF 正式申請單已作為附件附加。
                </div>
            </div>
            `;

            pdfSections = [
                {
                    title: 'A. 基本聯絡資訊',
                    rows: [
                        { label: '填表日期', value: applyDate },
                        { label: '公司名稱', value: company },
                        { label: '聯絡人（職稱）', value: contact },
                        { label: '電子信箱', value: email },
                        { label: '電話及分機', value: tel },
                        { label: '手機號碼', value: mobile },
                        { label: '傳真號碼', value: fax },
                        { label: '樣品寄送地址', value: address }
                    ]
                },
                {
                    title: 'B. 應用需求',
                    rows: [
                        { label: '應用領域', value: appFieldsStr },
                        { label: '功能需求', value: fullFunc },
                        { label: '系統型態', value: systems },
                        { label: '組份 / 外觀', value: `${compType} / ${appType}` }
                    ]
                },
                {
                    title: 'C. 基本資訊與規格',
                    rows: [
                        { label: '底材類型', value: substratesStr },
                        { label: '乾膜厚度', value: filmThick },
                        { label: '乾燥固化條件', value: cureCondition },
                        { label: '樹脂系統', value: resinsStr },
                        { label: '其他資訊(限用物質)', value: restricted },
                        { label: '索樣產品資訊', value: sampleReq },
                        { label: '需求文件', value: docs }
                    ]
                },
                {
                    title: 'D & E. 曾測試紀錄與備註',
                    rows: [
                        { label: '曾試過的相關樣品', value: pastSamples },
                        { label: '備註 / 其他說明', value: remarks }
                    ]
                }
            ];
        }

        let pdfBuffer = null;
        const pdfFilename = isQuickMode ? `${company}_快速樣品申請單.pdf` : `${company}_詳細樣品申請單.pdf`;

        // 動態生成單頁 PDF 附件
        try {
            pdfBuffer = await createStyledPDF(
                isQuickMode ? `${company} - 快速樣品申請單` : `${company} - 詳細樣品申請與技術評估單`,
                pdfSections,
                company
            );

            attachments.push({
                filename: pdfFilename,
                content: pdfBuffer,
                contentType: 'application/pdf'
            });
        } catch (pdfErr) {
            console.error('PDF 生成錯誤:', pdfErr);
        }

        // 同步寫入 Google 試算表（含雲端 PDF）並取得雲端連結
        let pdfUrl = '';
        try {
            const sheetResult = await appendToGoogleSheet(data, pdfBuffer, pdfFilename);
            if (sheetResult && sheetResult.pdfUrl) {
                pdfUrl = sheetResult.pdfUrl;
            }
        } catch (sheetErr) {
            console.error('[GoogleSheet Lambda Error]:', sheetErr);
        }

        const pdfActionBtn = pdfUrl
            ? `<a href="${pdfUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: bold;">📄 線上開啟 PDF 申請單 ➔</a>`
            : '';
        htmlContent = htmlContent.replace('{{PDF_ACTION_BUTTON}}', pdfActionBtn);

        // 郵件傳輸設定（支援 SES SMTP 或企業自建 SMTP 如 mail.attech.com.tw）
        const SMTP_HOST = process.env.SES_SMTP_HOST || process.env.SMTP_HOST || 'email-smtp.us-east-1.amazonaws.com';
        const SMTP_PORT = parseInt(process.env.SES_SMTP_PORT || process.env.SMTP_PORT || '465', 10);
        const SMTP_USER = process.env.SES_SMTP_USER || process.env.SMTP_USER;
        const SMTP_PASS = process.env.SES_SMTP_PASS || process.env.SMTP_PASS;
        const FROM_EMAIL = process.env.FROM_EMAIL || 'atservice@attech.com.tw';
        const TO_EMAIL = process.env.TO_EMAIL || 'atservice@attech.com.tw';
        const CC_EMAIL = process.env.CC_EMAIL || '';

        if (!SMTP_USER || !SMTP_PASS) {
            throw new Error(`SMTP 帳號密碼尚未設定（請於 AWS Lambda 環境變數中設定 SMTP_USER 與 SMTP_PASS）`);
        }

        // CC 副本名單 (若有設定才加入)
        let ccList = CC_EMAIL ? [CC_EMAIL] : [];
        if (data.cc) {
            if (Array.isArray(data.cc)) {
                ccList = ccList.concat(data.cc);
            } else if (typeof data.cc === 'string') {
                ccList.push(data.cc);
            }
        }
        ccList = [...new Set(ccList.filter(Boolean))];

        console.log(`[SMTP Attempt] Host: ${SMTP_HOST}:${SMTP_PORT}, User: ${SMTP_USER ? SMTP_USER.substring(0, 4) + '***' : 'EMPTY'}, Secure: ${SMTP_PORT === 465}`);

        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS
            },
            tls: {
                rejectUnauthorized: false
            },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 5000
        });

        const mailOptions = {
            from: `"ATTech 官網表單" <${FROM_EMAIL}>`,
            to: TO_EMAIL,
            replyTo: email,
            subject: subject,
            text: textContent,
            html: htmlContent,
            attachments: attachments
        };

        if (ccList.length > 0) {
            mailOptions.cc = ccList;
        }

        await transporter.sendMail(mailOptions);
        console.log(`[Lambda Sent] ${company} - ${contact} (${type})`);

// Google 試算表與雲端硬碟已於發信前完成同步

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                success: true,
                message: '需求表單及 PDF 申請單已成功寄出！專人將儘速與您聯繫。'
            })
        };

    } catch (error) {
        console.error('Lambda 處理郵件失敗:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                success: false,
                message: '伺服器處理郵件發送失敗，請稍後再試或直接聯繫客服。',
                error: error.message,
                code: error.code || null
            })
        };
    }
};

exports.createStyledPDF = createStyledPDF;

