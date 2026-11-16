try {
    require('dotenv').config();
} catch (e) {
    // dotenv is optional if environment variables are injected by system/Docker/PM2
}

const express = require('express');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_SHEET_VIEW_URL = process.env.GOOGLE_SHEET_VIEW_URL || 'https://docs.google.com/spreadsheets/d/1rsS0tsO1kX9G0HPSBerrI9Jo8SerZRAzjTrMMPNYays/edit?gid=317142515#gid=317142515';

// ----------------------------------------------------
// 0. PIMS 集中資料庫即時連線 (Single Source of Truth)
// ----------------------------------------------------
let pimsDb = null;
try {
    const Database = require('D:/Jay/vscode/techdatas/node_modules/better-sqlite3');
    const pimsDbPath = path.resolve('D:/Jay/vscode/techdatas/chemical_pims.db');
    if (fs.existsSync(pimsDbPath)) {
        pimsDb = new Database(pimsDbPath, { readonly: true, fileMustExist: true });
        pimsDb.pragma('journal_mode = WAL');
        console.log('✅ [PIMS DB] 成功直連公槽核心資料庫 (chemical_pims.db)，實現動態即時資料同步！');
    }
} catch (err) {
    console.warn('⚠️ [PIMS DB] 公槽資料庫直連未就緒，使用靜態快取備援:', err.message);
}

let productErpMap = {};
try {
    const erpMapPath = path.join(__dirname, 'product_erp_map.json');
    if (fs.existsSync(erpMapPath)) {
        productErpMap = JSON.parse(fs.readFileSync(erpMapPath, 'utf-8'));
    }
} catch (e) {
    console.warn('[ERP MAP] 未能載入 product_erp_map.json:', e.message);
}

function resolveProductErp(name) {
    if (!name || typeof name !== 'string') return null;
    const clean = name.trim();
    
    // 優先向活體 PIMS 資料庫即時查詢
    if (pimsDb) {
        try {
            const row = pimsDb.prepare(`
                SELECT erp_no FROM products 
                WHERE erp_no = ? 
                   OR web_display_name = ? 
                   OR product_name = ?
                   OR web_display_name = ? COLLATE NOCASE
                LIMIT 1
            `).get(clean, clean, clean, clean);
            if (row && row.erp_no) return row.erp_no;
        } catch (e) {}
    }

    if (productErpMap[clean]) return productErpMap[clean].erp_no;
    if (productErpMap[clean.toLowerCase()]) return productErpMap[clean.toLowerCase()].erp_no;
    const pure = clean.replace(/（[^）]+）|\([^)]+\)/g, '').trim();
    if (productErpMap[pure]) return productErpMap[pure].erp_no;
    if (productErpMap[pure.toLowerCase()]) return productErpMap[pure.toLowerCase()].erp_no;
    return null;
}

function formatProductWithErp(itemStr) {
    if (!itemStr || typeof itemStr !== 'string') return itemStr;
    const erp = resolveProductErp(itemStr);
    if (erp && !itemStr.includes(`[ERP: ${erp}]`)) {
        return `${itemStr} [ERP: ${erp}]`;
    }
    return itemStr;
}

function enrichWithLivePims(items) {
    if (!pimsDb || !Array.isArray(items)) return items;
    try {
        const stmt = pimsDb.prepare(`
            SELECT erp_no, category_id, product_name, web_display_name, cas_display,
                   reach_status, rohs_status, food_contact_fda, pfoa_pfos, un_no, dg_class,
                   packaging_spec
            FROM products
            WHERE is_active = 1
        `);
        const allDbProds = stmt.all();
        
        // Build fast map
        const dbMap = {};
        for (const p of allDbProds) {
            if (p.erp_no) dbMap[p.erp_no] = p;
            if (p.web_display_name) {
                dbMap[p.web_display_name.trim().toLowerCase()] = p;
            }
            if (p.product_name) {
                dbMap[p.product_name.trim().toLowerCase()] = p;
            }
        }
        
        for (const it of items) {
            const pName = (it.product_name || '').trim().toLowerCase();
            const pErp = it.erp_no;
            const match = (pErp && dbMap[pErp]) || dbMap[pName];
            if (match) {
                it.erp_no = match.erp_no;
                it.cas_no = match.cas_display || it.cas_no || '';
                it.packaging_spec = match.packaging_spec || '';
                it.compliance = {
                    reach: match.reach_status || '-',
                    rohs: match.rohs_status || '-',
                    fda: match.food_contact_fda || '-',
                    pfoa_pfos: match.pfoa_pfos || '-',
                    un_no: match.un_no || '-',
                    dg_class: match.dg_class || '-'
                };
                it.pims_live = true;
            }
        }
    } catch (e) {
        console.warn('[PIMS ENRICH] 即時注入警告:', e.message);
    }
    return items;
}

// ----------------------------------------------------
// 1. CORS & Middleware 設定
// ----------------------------------------------------
const defaultOrigins = [
    'https://rosf000.github.io',
    'https://www.attech.com.tw',
    'https://attech.com.tw',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:63342',
    'http://127.0.0.1:63342'
];

const customOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : [];

const allowedOrigins = [...defaultOrigins, ...customOrigins];

app.use(cors({
    origin: function (origin, callback) {
        // 允許無 origin 的請求 (例如 curl, Postman 或同源請求)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.github.io') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
            return callback(null, true);
        }
        return callback(null, true); // 正式開放跨域存取
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 安全性回應標頭與快取中介軟體
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 靜態資源目錄（提供 doc, tds, img 下載與靜態託管，並配置快取）
// ----------------------------------------------------
// 1.5. 動態產品 API 與 PIMS 資料庫即時直連攔截器 (Single Source of Truth)
// ----------------------------------------------------
// (A) 提供全產品即時 REST API
app.get('/api/live/products', (req, res) => {
    if (!pimsDb) {
        return res.status(503).json({ error: 'PIMS Database connection not available' });
    }
    try {
        const { search, category, erp } = req.query;
        let sql = 'SELECT * FROM products WHERE is_active = 1';
        const params = [];
        if (erp) {
            sql += ' AND erp_no = ?';
            params.push(erp);
        }
        if (category) {
            sql += ' AND erp_no LIKE ?';
            params.push(`${category}%`);
        }
        if (search) {
            sql += ' AND (product_name LIKE ? OR web_display_name LIKE ? OR cas_display LIKE ? OR erp_no LIKE ?)';
            const term = `%${search}%`;
            params.push(term, term, term, term);
        }
        sql += ' ORDER BY erp_no ASC';
        const rows = pimsDb.prepare(sql).all(...params);
        res.json({ total: rows.length, products: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// (B) 攔截前端靜態 JSON 載入，即時自 PIMS 注入最新物性與合規數據
app.get('/json/:brand/:file', (req, res, next) => {
    const filename = req.params.file;
    if (!filename.endsWith('.json')) return next();
    
    const filePath = path.join(__dirname, 'json', req.params.brand, filename);
    if (!fs.existsSync(filePath)) return next();

    try {
        let items = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(items) && pimsDb) {
            items = enrichWithLivePims(items);
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.json(items);
    } catch (e) {
        return next();
    }
});

app.use(express.static(path.join(__dirname), {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg|pdf|docx|woff2?)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        }
    }
}));

// ----------------------------------------------------
// 2. 郵件發送器配置（優先 Resend，次之 SMTP）
// ----------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
let resendClient = null;
if (RESEND_API_KEY) {
    resendClient = new Resend(RESEND_API_KEY);
    console.log('✅ Resend 郵件服務已啟用 (RESEND_API_KEY)');
}

const SMTP_HOST = process.env.SMTP_HOST || 'mail.attech.com.tw';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || 'atservice@attech.com.tw';
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false'; // 預設 465 為 SSL/TLS

let transporter = null;
if (!RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        },
        tls: {
            rejectUnauthorized: false
        }
    });
    console.log(`✅ SMTP 郵件服務已配置: ${SMTP_USER}@${SMTP_HOST}:${SMTP_PORT}`);
}

// ----------------------------------------------------
// 3. PDF 報表生成輔助函式
// ----------------------------------------------------
function formatList(val) {
    if (Array.isArray(val)) {
        return val.length > 0 ? val.join('、') : '無';
    }
    return val || '無';
}

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

        // 字型路徑 (支援 Linux 雲端與本機環境)
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
        } else if (fs.existsSync(regularFontPath)) {
            doc.registerFont('ChineseBold', regularFontPath);
            fontBold = 'ChineseBold';
        }

        const pageWidth = doc.page.width - 56; // Left 28 + Right 28 = 56
        const startX = 28;

        // Header 頂部公司抬頭
        doc.font(fontBold).fontSize(14).fillColor('#0F2C59').text('宏威應用材料 ATTech Materials', startX, 22, { align: 'left' });
        doc.font(fontRegular).fontSize(8).fillColor('#475569').text('Discover The Link To Life | 40661 台中市北屯區廍子巷116號1樓 | TEL: +886-4-2239-8056', startX, 38, { align: 'left' });

        doc.moveTo(startX, 50).lineTo(startX + pageWidth, 50).strokeColor('#1E3A8A').lineWidth(1.5).stroke();

        // 表單大標題
        doc.y = 56;
        doc.font(fontBold).fontSize(12).fillColor('#1E3A8A').text(title, { align: 'center' });
        doc.moveDown(0.25);

        // 計算列高與版面緊湊度
        let totalRows = 0;
        sections.forEach(sec => {
            totalRows += (sec.rows ? sec.rows.length : 0);
        });

        // 版面最佳化：動態調整列高與字級，充實填滿 A4 頁面且嚴格保證單頁
        const isCompact = totalRows > 15;
        const baseRowHeight = isCompact ? 23 : 26;
        const fontSize = isCompact ? 9 : 9.5;
        const sectionHeaderHeight = isCompact ? 19 : 21;

        // 逐區塊繪製表格
        sections.forEach(section => {
            const secHeaderY = doc.y;

            // 區塊標題列
            doc.rect(startX, secHeaderY, pageWidth, sectionHeaderHeight).fill('#E2E8F0');
            doc.font(fontBold).fontSize(8.5).fillColor('#0F2C59').text(`  ${section.title}`, startX + 4, secHeaderY + 3.5);

            doc.y = secHeaderY + sectionHeaderHeight;

            // 內容行
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

        // 頁尾 Footer
        const currentDate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }).replace(/\u202f/g, ' ');
        const footerY = doc.page.height - 28;

        doc.moveTo(startX, footerY - 4).lineTo(startX + pageWidth, footerY - 4).strokeColor('#CBD5E1').lineWidth(0.5).stroke();
        doc.font(fontRegular).fontSize(7.5).fillColor('#64748B').text(`列印時間：${currentDate} | 宏威應用材料 Discover The Link To Life`, startX, footerY, { width: pageWidth, align: 'left', lineBreak: false });
        doc.font(fontRegular).fontSize(7.5).fillColor('#64748B').text(`第 1 頁 / 共 1 頁`, startX, footerY, { width: pageWidth, align: 'right', lineBreak: false });

        doc.end();
    });
}

// ----------------------------------------------------
// 4. API 路由端點
// ----------------------------------------------------

// 伺服器健康檢查（供 Render 與除錯使用）
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'ATTech Materials API Server',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'production',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// 取得檔案路徑資訊 (供 Outlook 複製貼上使用)
app.get('/api/file-path', (req, res) => {
    try {
        let relPath = req.query.path || '';
        if (!relPath) {
            return res.status(400).json({ error: 'Missing path parameter' });
        }
        relPath = decodeURIComponent(relPath).replace(/^\.?\/+/, '');
        const localFullPath = path.resolve(__dirname, relPath);
        if (!fs.existsSync(localFullPath)) {
            return res.status(404).json({ error: 'File not found on local disk', path: localFullPath });
        }
        return res.json({
            relPath: relPath,
            fullPath: localFullPath,
            filename: path.basename(localFullPath),
            fileUrl: `file:///${localFullPath.replace(/\\/g, '/')}`
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 60 秒防重複提交快取 (防止連擊與重複寄信)
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

// 同步將需求紀錄寫入 Google 試算表（非同步背景發送，不阻礙使用者表單體驗）
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
        console.log(`[GoogleSheet] Synced row: ${payload.company} (HTTP ${res.status}), pdfUrl: ${resJson.pdfUrl || 'none'}`);
        return resJson;
    } catch (err) {
        console.error('[GoogleSheet Error]:', err.message);
    }
}

// 表單提交與郵件發送端點
app.post('/api/send-email', async (req, res) => {
    try {
        const data = req.body;
        const { company, contact, email, type } = data;

        if (!company || !contact || !email) {
            return res.status(400).json({
                success: false,
                message: '請填寫必填欄位（公司名稱、聯絡人、電子信箱）'
            });
        }

        // 短時間去重指紋 (避免快速連點或重複發信)
        const dedupSample = (data.sample || data.sampleReq || (Array.isArray(data.sampleItems) ? data.sampleItems.map(s => s.name).join(';') : '') || data.message || '').trim().toLowerCase();
        const dedupKey = `${(email || '').trim().toLowerCase()}###${(company || '').trim().toLowerCase()}###${dedupSample}`;

        const lastSeen = recentSubmissions.get(dedupKey);
        const now = Date.now();
        if (lastSeen && (now - lastSeen < SUBMISSION_COOLDOWN_MS)) {
            const waitSeconds = Math.ceil((SUBMISSION_COOLDOWN_MS - (now - lastSeen)) / 1000);
            console.log(`[DEDUP] 偵測到 ${email} (${company}) 於 ${60 - waitSeconds}s 前已送出相同需求，已安全攔截重複郵件`);
            return res.json({
                success: true,
                isDuplicate: true,
                message: `您的需求表單已成功送出並在處理中，專員將儘速與您聯繫（請稍候 ${waitSeconds} 秒後再試，系統已自動為您合併）。`
            });
        }

        cleanupOldSubmissions();
        recentSubmissions.set(dedupKey, now);

        const isQuickMode = (type === '快速詢價' || !data.appFields);
        let subject = `【官網需求單】${company} - ${contact}（${isQuickMode ? '指定樣品/快速詢價' : '詳細應用需求評估'}）`;
        let textContent = '';
        let htmlContent = '';
        let attachments = [];
        let pdfSections = [];

        if (isQuickMode) {
            const applyDate = (data.applyDate || new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })).replace(/-/g, '/');
            const mobile = data.mobile || data.phone || data.tel || '未提供';
            const rawSample = data.sample || '未提供';
            const sample = formatProductWithErp(rawSample);
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
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; width: 150px; color: #475569; background-color: #f8fafc;">公司名稱</td><td style="padding: 8px;">${company}</td></tr>
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
            // 詳細需求模式
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
                    .map(it => {
                        const erp = resolveProductErp(it.name);
                        const erpTag = erp ? ` [ERP: ${erp}]` : '';
                        return it.qty ? `${it.name.trim()}${erpTag}（數量: ${it.qty.trim()}）` : `${it.name.trim()}${erpTag}`;
                    });
                if (items.length > 0) {
                    sampleReq = items.join('；');
                }
            } else if (sampleReq !== '未填寫') {
                sampleReq = formatProductWithErp(sampleReq);
            }

            const docs = formatList(data.docs);
            const pastSamples = data.pastSamples || '無';
            const remarks = data.remarks || '無';

            textContent = `
【宏威應用材料 - 詳細應用需求評估單 (完整申請單)】
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

D & E. 測試紀錄與備註
曾試過的相關樣品：${pastSamples}
備註 / 其他說明：${remarks}
--------------------------------------------------
時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
            `;

            htmlContent = `
            <div style="font-family: Arial, 'Microsoft JhengHei', sans-serif; max-width: 700px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b; background-color: #ffffff;">
                <div style="border-bottom: 2px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 16px;">
                    <h2 style="color: #0f2c59; margin: 0 0 4px 0; font-size: 20px;">宏威應用材料 ATTech Materials</h2>
                    <p style="color: #1e3a8a; font-weight: bold; margin: 0; font-size: 15px;">詳細應用需求評估 (完整申請單)</p>
                </div>

                <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;">
                    <div style="font-weight: bold; color: #166534; font-size: 14px; margin-bottom: 4px;">📊 雲端自動同步提醒</div>
                    <div style="font-size: 12px; color: #15803d; margin-bottom: 10px;">本筆需求已即時自動歸檔至 Google 需求紀錄總表，PDF 申請單已同步存入雲端硬碟。</div>
                    <div>
                        <a href="${GOOGLE_SHEET_VIEW_URL}" target="_blank" style="display: inline-block; background-color: #16a34a; color: #ffffff; text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-right: 8px;">📊 開啟 Google 需求總表 ➔</a>
                        {{PDF_ACTION_BUTTON}}
                    </div>
                </div>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 10px; border-left: 4px solid #1e3a8a; font-size: 14px; margin: 16px 0 8px 0;">A. 基本聯絡資訊</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">填表日期：</td><td style="padding: 6px;">${applyDate}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">公司名稱：</td><td style="padding: 6px;">${company}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">聯絡人（職稱）：</td><td style="padding: 6px;">${contact}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">電子信箱：</td><td style="padding: 6px;"><a href="mailto:${email}" style="color: #1e3a8a;">${email}</a></td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">聯絡電話 / 手機：</td><td style="padding: 6px;">${mobile}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">傳真號碼：</td><td style="padding: 6px;">${fax}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">寄送地址：</td><td style="padding: 6px;">${address}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 10px; border-left: 4px solid #1e3a8a; font-size: 14px; margin: 16px 0 8px 0;">B. 應用需求</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">應用領域：</td><td style="padding: 6px;">${appFieldsStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">功能需求：</td><td style="padding: 6px;">${fullFunc}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">系統型態：</td><td style="padding: 6px;">${systems}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">組份 / 外觀：</td><td style="padding: 6px;">${compType} / ${appType}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 10px; border-left: 4px solid #1e3a8a; font-size: 14px; margin: 16px 0 8px 0;">C. 基本資訊與規格</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 12px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">底材類型：</td><td style="padding: 6px;">${substratesStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾膜厚度：</td><td style="padding: 6px;">${filmThick}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾燥固化條件：</td><td style="padding: 6px;">${cureCondition}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">樹脂系統：</td><td style="padding: 6px;">${resinsStr}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">限用物質：</td><td style="padding: 6px;">${restricted}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #1e3a8a; background-color: #eff6ff;">索樣產品資訊：</td><td style="padding: 6px; font-weight: bold; color: #1e3a8a;">${sampleReq}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">需求文件：</td><td style="padding: 6px;">${docs}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 10px; border-left: 4px solid #1e3a8a; font-size: 14px; margin: 16px 0 8px 0;">D & E. 測試紀錄與備註</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">曾試過的相關樣品：</td><td style="padding: 6px; white-space: pre-wrap;">${pastSamples}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">備註 / 其他說明：</td><td style="padding: 6px; white-space: pre-wrap;">${remarks}</td></tr>
                </table>

                <div style="font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    ※ 此郵件由 ATTech 官網系統自動發出，詳細評估 PDF 正式申請單已作為附件附加。
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
                        { label: '寄送地址', value: address }
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

        // 動態生成美觀單頁 PDF 附件
        try {
            const pdfBuffer = await createStyledPDF(
                isQuickMode ? `${company} - 快速樣品申請單` : `${company} - 詳細應用需求評估單`,
                pdfSections,
                company
            );

            attachments.push({
                filename: isQuickMode ? `${company}_快速樣品申請單.pdf` : `${company}_詳細樣品申請單.pdf`,
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
            console.error('[GoogleSheet Server Error]:', sheetErr);
        }

        const pdfActionBtn = pdfUrl
            ? `<a href="${pdfUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: bold;">📄 線上開啟 PDF 申請單 ➔</a>`
            : '';
        htmlContent = htmlContent.replace('{{PDF_ACTION_BUTTON}}', pdfActionBtn);

        // CC 副本名單
        let ccList = ['sales1@attech.com.tw'];
        if (data.cc) {
            if (Array.isArray(data.cc)) {
                ccList = ccList.concat(data.cc);
            } else if (typeof data.cc === 'string') {
                ccList.push(data.cc);
            }
        }

        // 優先使用 Resend 發信
        if (resendClient) {
            const fromEmail = process.env.FROM_EMAIL || 'ATTech 官網系統 <onboarding@resend.dev>';
            const toEmail = process.env.TO_EMAIL || 'atservice@attech.com.tw';

            const sendResult = await resendClient.emails.send({
                from: fromEmail,
                to: [toEmail],
                cc: ccList,
                reply_to: email,
                subject: subject,
                text: textContent,
                html: htmlContent,
                attachments: attachments
            });

            if (sendResult.error) {
                throw new Error(sendResult.error.message || 'Resend 發信失敗');
            }

            console.log(`[Resend Sent] ${company} - ${contact} (${type}) ID: ${sendResult.data?.id}`);
        } else {
            // SMTP 發信模式
            const mailOptions = {
                from: `"ATTech 官網表單" <${SMTP_USER}>`,
                to: SMTP_USER,
                cc: ccList,
                replyTo: email,
                subject: subject,
                text: textContent,
                html: htmlContent,
                attachments: attachments
            };

            await transporter.sendMail(mailOptions);
            console.log(`[SMTP Sent] ${company} - ${contact} (${type})`);
        }

// Google 試算表與雲端硬碟已於發信前完成同步

        res.status(200).json({
            success: true,
            message: '需求表單及 PDF 申請單已成功寄出！專人將儘速與您聯繫。'
        });

    } catch (error) {
        console.error('Submit form error:', error);
        res.status(500).json({
            success: false,
            message: '伺服器處理郵件發送失敗，請稍後再試或直接聯繫客服。',
            error: error.message
        });
    }
});

// ----------------------------------------------------
// 5. SPA 萬用路由回退機制 (HTML5 History API Clean URLs)
// ----------------------------------------------------
app.get('{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------------------------------------------
// 6. 啟動伺服器
// ----------------------------------------------------
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 ATTech API 伺服器啟動成功！`);
    console.log(`📡 監聽連接埠: ${PORT}`);
    console.log(`🔗 健康檢查端點: http://localhost:${PORT}/api/health`);
    console.log(`=========================================`);
});