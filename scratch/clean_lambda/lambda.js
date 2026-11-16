/**
 * AWS Lambda 入口代理 (轉發至 index.js)
 * 確保不論 Lambda Handler 設定為 index.handler 或 lambda.handler 均可正常執行
 */
module.exports = require('./index.js');
