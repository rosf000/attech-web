const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const path = require('path');

const app = express();

app.use(cors({
    origin: [
        'http://localhost:63342',
        'http://127.0.0.1:63342',
        'http://localhost:3000',
        'https://www.attech.com.tw'
    ]
}));
app.use(express.json());

const transporter = nodemailer.createTransport({
    host: 'mail.attech.com.tw',
    port: 465,
    secure: true,
    auth: {
        user: 'atservice@attech.com.tw',
        pass: '27819118'
    },
    tls: {
        rejectUnauthorized: false
    }
});

const formatList = (val) => {
    if (Array.isArray(val)) {
        return val.length > 0 ? val.join('、') : '無';
    }
    return val || '無';
};

/**
 * 繪製帶有表格、公司頁首與頁尾頁碼的 PDF 報表 Buffer (全黑字型，精簡壓縮單頁版)
 */
function createStyledPDF(title, sections, companyName) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 25, // 縮小邊界 (25pt) 增加可繪製空間
            bufferPages: true
        });

        let buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // --- 載入與註冊中文字型 ---
        const fontPath = path.join(__dirname, 'fonts', 'NotoSansTC-Regular.ttf');

        try {
            doc.registerFont('CustomChinese', fontPath);
            doc.font('CustomChinese');
        } catch (e) {
            console.error('字型載入失敗，請確認檔案路徑與格式：', e);
        }

        const pageWidth = doc.page.width - 50; // Margin 25 * 2 = 50
        const startX = 25;

        // --- 頁首 Header (字體全黑) ---
        doc.font('CustomChinese')
            .fillColor('#000000')
            .fontSize(14)
            .text('宏威應用材料 ATTech Materials', startX, 25, {align: 'left'});

        doc.font('CustomChinese')
            .fillColor('#000000')
            .fontSize(8)
            .text('Specialty Chemical Solutions | 40661 台中市北屯區廍子巷116號1樓 | TEL: +886-4-2239-8056', startX, 42, {align: 'left'});

        doc.moveTo(startX, 54)
            .lineTo(startX + pageWidth, 54)
            .strokeColor('#000000')
            .lineWidth(1.5)
            .stroke();

        // 表單大標題 (字體全黑)
        doc.y = 60;
        doc.fillColor('#000000')
            .fontSize(13)
            .text(title, {align: 'center'});
        doc.moveDown(0.3);

        // --- 計算總行數以動態調整表格列高 (Row Height) ---
        let totalRows = 0;
        sections.forEach(sec => {
            totalRows += sec.rows.length;
        });

        // 計算適當列高 (詳盡模式下多欄位時縮減至 15px，確保一頁裝得下)
        const rowHeight = totalRows > 12 ? 15 : 18;
        const fontSize = totalRows > 12 ? 8 : 8.5;
        const sectionHeaderHeight = totalRows > 12 ? 16 : 18;

        // --- 繪製各區塊與欄位表格 ---
        sections.forEach(section => {
            const secHeaderY = doc.y;

            // 區塊標題 Header (背景可改淺灰或微灰色襯托，文字全黑)
            doc.rect(startX, secHeaderY, pageWidth, sectionHeaderHeight)
                .fill('#e2e8f0');

            doc.fillColor('#000000')
                .fontSize(9)
                .text(`  ${section.title}`, startX + 5, secHeaderY + 3);

            doc.y = secHeaderY + sectionHeaderHeight;

            // 區塊內容表格
            section.rows.forEach(row => {
                const currentY = doc.y;
                const labelWidth = 130;
                const valueWidth = pageWidth - labelWidth;

                // 背景與邊框
                doc.rect(startX, currentY, labelWidth, rowHeight)
                    .fillAndStroke('#f8fafc', '#cbd5e1');
                doc.rect(startX + labelWidth, currentY, valueWidth, rowHeight)
                    .fillAndStroke('#ffffff', '#cbd5e1');

                // Label (字體全黑)
                doc.fillColor('#000000')
                    .fontSize(fontSize)
                    .text(row.label, startX + 6, currentY + (rowHeight === 15 ? 3 : 4), {
                        width: labelWidth - 10,
                        ellipsis: true
                    });

                // Value (字體全黑)
                doc.fillColor('#000000')
                    .fontSize(fontSize)
                    .text(row.value || '無', startX + labelWidth + 6, currentY + (rowHeight === 15 ? 3 : 4), {
                        width: valueWidth - 10,
                        ellipsis: true
                    });

                doc.y = currentY + rowHeight;
            });

            doc.y += 4; // 區塊間距縮小至 4pt
        });

        // --- 頁尾 Footer (字體全黑) ---
        const currentDate = new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'});
        const footerY = doc.page.height - 25;

        doc.moveTo(startX, footerY - 5)
            .lineTo(startX + pageWidth, footerY - 5)
            .strokeColor('#000000')
            .lineWidth(0.5)
            .stroke();

        doc.fillColor('#000000')
            .fontSize(7.5)
            .text(`列印時間：${currentDate} | 宏威應用材料股份有限公司`, startX, footerY, {align: 'left'});

        doc.fillColor('#000000')
            .fontSize(7.5)
            .text(`第 1 頁 / 共 1 頁`, startX, footerY, {align: 'right'});

        doc.end();
    });
}

app.post('/api/send-email', async (req, res) => {
    const data = req.body;

    // 前端已統一欄位命名，直接解構讀取
    const {company, contact, email, type} = data;

    if (!company || !contact || !email) {
        return res.status(400).json({success: false, message: '請填寫必填欄位（公司名稱、聯絡人、Email）'});
    }

    const isQuickMode = type === '快速詢價';
    let subject = `【${company} - ${contact}】【樣品申請單】`;
    let textContent = '';
    let htmlContent = '';
    let attachments = [];
    let pdfSections = [];

    if (isQuickMode) {
        const {
            mobile = '未提供',
            phone = '未提供',
            sample = '未提供',
            address = '未提供',
            message = '無'
        } = data;

        textContent = `
===== 宏威應用材料 - 指定樣品 / 快速詢價 =====
公司名稱：${company}
聯絡人：${contact}
電子信箱：${email}
手機：${mobile}
電話及分機：${phone}
指定索樣產品與數量：${sample}
樣品寄送地址：${address}
備註 / 詢問內容：
${message}
=========================================
        `.trim();

        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 650px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 24px; background-color: #ffffff;">
                <h2 style="color: #1e3a8a; border-bottom: 3px solid #1e3a8a; padding-bottom: 10px; margin-top: 0;">【指定樣品 / 快速詢價通知】</h2>
                <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; width: 140px; color: #475569;">公司名稱：</td><td style="padding: 8px; font-weight: bold; color: #0f172a;">${company}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">聯絡人（職稱）：</td><td style="padding: 8px;">${contact}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">電子信箱：</td><td style="padding: 8px;"><a href="mailto:${email}" style="color: #2563eb;">${email}</a></td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">手機：</td><td style="padding: 8px;">${mobile}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">電話及分機：</td><td style="padding: 8px;">${phone}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">索樣產品與數量：</td><td style="padding: 8px; color: #1e3a8a; font-weight: bold;">${sample}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 8px; font-weight: bold; color: #475569;">寄送地址：</td><td style="padding: 8px;">${address}</td></tr>
                </table>
                <div style="margin-top: 20px; background-color: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <strong style="color: #334155; display: block; margin-bottom: 5px;">備註 / 詢問內容：</strong>
                    <p style="margin: 0; white-space: pre-wrap; font-size: 13px; color: #475569;">${message}</p>
                </div>
            </div>
        `;

        pdfSections = [
            {
                title: '基本聯絡資訊與需求',
                rows: [
                    {label: '公司名稱', value: company},
                    {label: '聯絡人（職稱）', value: contact},
                    {label: '電子信箱', value: email},
                    {label: '手機', value: mobile},
                    {label: '電話及分機', value: phone},
                    {label: '指定索樣產品與數量', value: sample},
                    {label: '樣品寄送地址', value: address},
                    {label: '備註 / 詢問內容', value: message}
                ]
            }
        ];

    } else {
        const phone = data.phone || '未提供';
        const mobile = data.mobile || '未提供';
        const fax = data.fax || '未提供';
        const address = data.address || '未提供';

        const appFields = formatList(data.appFields);
        const functions = formatList(data.functions);
        const otherFunc = data.otherFunc || '無';
        const systems = formatList(data.systems);
        const compType = data.compType || '未指定';
        const appType = data.appType || '未指定';

        const substrates = formatList(data.substrates);
        const otherSubstrate = data.otherSubstrate || '無';
        const filmThick = data.filmThick ? `${data.filmThick} μm` : '未填寫';
        const noBake = data.noBake || '否';
        const bakeTemp = data.bakeTemp || '未填寫';
        const bakeTime = data.bakeTime || '未填寫';
        const resins = formatList(data.resins);
        const restricted = data.restricted || '無';
        const sampleReq = data.sampleReq || '未提供';
        const docs = formatList(data.docs);
        const pastSamples = data.pastSamples || '無';
        const remarks = data.remarks || '無';

        textContent = `
===== 宏威應用材料 - 詳細樣品申請單 =====
公司名稱：${company}
聯絡人：${contact}
電子信箱：${email}
電話：${phone}
手機：${mobile}
傳真：${fax}
寄送地址：${address}

【應用需求】
應用領域：${appFields}
功能需求：${functions}
其他功能：${otherFunc}
系統型態：${systems}
組份 / 外觀：${compType} / ${appType}

【規格】
底材類型：${substrates} (其他：${otherSubstrate})
乾膜厚度：${filmThick}
不烘烤(風乾)：${noBake}
烘烤條件：溫度 ${bakeTemp}，時間 ${bakeTime}
樹脂系統：${resins}
限用物質：${restricted}
索樣需求：${sampleReq}
需求文件：${docs}
曾測試紀錄：${pastSamples}
備註說明：${remarks}
================================================
        `.trim();

        htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 750px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 24px; background-color: #ffffff;">
                <h2 style="color: #1e3a8a; border-bottom: 3px solid #1e3a8a; padding-bottom: 10px; margin-top: 0;">${company} -【詳細樣品申請單】</h2>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 12px; border-left: 4px solid #1e3a8a; font-size: 15px; margin-top: 20px;">A. 基本聯絡資訊</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">公司名稱：</td><td style="padding: 6px; font-weight: bold; color: #0f172a;">${company}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">聯絡人（職稱）：</td><td style="padding: 6px;">${contact}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">電子信箱：</td><td style="padding: 6px;"><a href="mailto:${email}" style="color: #2563eb;">${email}</a></td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">電話：</td><td style="padding: 6px;">${phone}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">手機：</td><td style="padding: 6px;">${mobile}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">傳真：</td><td style="padding: 6px;">${fax}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">寄送地址：</td><td style="padding: 6px;">${address}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 12px; border-left: 4px solid #1e3a8a; font-size: 15px; margin-top: 20px;">B. 應用需求</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">應用領域：</td><td style="padding: 6px;">${appFields}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">產品/功能需求(其他)：</td><td style="padding: 6px;">${functions} (其他: ${otherFunc})</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">系統型態：</td><td style="padding: 6px;">${systems}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">組份 / 外觀：</td><td style="padding: 6px;">${compType} / ${appType}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 12px; border-left: 4px solid #1e3a8a; font-size: 15px; margin-top: 20px;">C. 基本資訊與規格</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; width: 140px; color: #475569;">底材類型：</td><td style="padding: 6px;">${substrates} (其它: ${otherSubstrate})</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾膜厚度：</td><td style="padding: 6px;">${filmThick}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">乾燥固化條件：</td><td style="padding: 6px;">不烘烤: ${noBake} | 溫度: ${bakeTemp} °C | 時間: ${bakeTime} 分鐘</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">樹脂系統：</td><td style="padding: 6px;">${resins}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">限用物質：</td><td style="padding: 6px;">${restricted}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #1e3a8a;">索樣產品需求：</td><td style="padding: 6px; font-weight: bold; color: #1e3a8a;">${sampleReq}</td></tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;"><td style="padding: 6px; font-weight: bold; color: #475569;">需求文件：</td><td style="padding: 6px;">${docs}</td></tr>
                </table>

                <h3 style="color: #1e3a8a; background-color: #eff6ff; padding: 6px 12px; border-left: 4px solid #1e3a8a; font-size: 15px; margin-top: 20px;">D & E. 測試紀錄與備註</h3>
                <div style="font-size: 13px; padding: 6px;">
                    <p style="margin: 4px 0;"><strong>曾試過的樣品：</strong> ${pastSamples}</p>
                    <p style="margin: 4px 0;"><strong>備註說明：</strong> ${remarks}</p>
                </div>
            </div>
        `;

        pdfSections = [
            {
                title: 'A. 基本聯絡資訊',
                rows: [
                    {label: '公司名稱', value: company},
                    {label: '聯絡人（職稱）', value: contact},
                    {label: '電子信箱', value: email},
                    {label: '電話', value: `${phone}`},
                    {label: '手機', value: `${mobile}`},
                    {label: '傳真', value: `${fax}`},
                    {label: '寄送地址', value: address}
                ]
            },
            {
                title: 'B. 應用需求',
                rows: [
                    {label: '應用領域', value: appFields},
                    {label: '產品/功能需求(其他)', value: `${functions} (其他: ${otherFunc})`},
                    {label: '系統型態', value: systems},
                    {label: '組份 / 外觀', value: `${compType} / ${appType}`}
                ]
            },
            {
                title: 'C. 基本資訊與規格',
                rows: [
                    {label: '底材類型', value: `${substrates} (其它: ${otherSubstrate})`},
                    {label: '乾膜厚度', value: filmThick},
                    {label: '乾燥固化條件', value: `不烘烤: ${noBake} | 溫度: ${bakeTemp} °C | 時間: ${bakeTime} 分鐘`},
                    {label: '樹脂系統', value: resins},
                    {label: '限用物質', value: restricted},
                    {label: '索樣產品需求', value: sampleReq},
                    {label: '需求文件', value: docs}
                ]
            },
            {
                title: 'D & E. 測試紀錄與備註',
                rows: [
                    {label: '曾試過的相關樣品', value: pastSamples},
                    {label: '備註 / 其他說明', value: remarks}
                ]
            }
        ];
    }

    // 動態生成 PDF 附件
    try {
        const pdfBuffer = await createStyledPDF(
            isQuickMode ? `${company} - 快速樣品申請單` : `${company} - 詳細樣品申請單`,
            pdfSections,
            company
        );

        attachments.push({
            filename: isQuickMode ? `${company}_快速樣品申請單.pdf` : `${company}_詳細樣品申請單.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
        });
    } catch (pdfErr) {
        console.error('PDF Generation Error:', pdfErr);
    }

    // CC 名單處理
    let ccList = ['sales1@attech.com.tw'];
    if (data.cc) {
        if (Array.isArray(data.cc)) {
            ccList = ccList.concat(data.cc);
        } else if (typeof data.cc === 'string') {
            ccList.push(data.cc);
        }
    }

    const mailOptions = {
        from: '"ATTech 官網表單" <atservice@attech.com.tw>',
        to: 'atservice@attech.com.tw',
        cc: ccList,
        replyTo: email,
        subject: subject,
        text: textContent,
        html: htmlContent,
        attachments: attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({success: true, message: '信件及 PDF 附件已成功寄出'});
    } catch (error) {
        console.error('Mail Send Error:', error);
        res.status(500).json({success: false, message: '信件寄送失敗'});
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));