const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // セキュリティ対策: パス名からクエリパラメータを削除し、相対パスのトラバーサルを防止
  let filePath = req.url.split('?')[0];
  if (filePath === '/') {
    filePath = '/index.html';
  }

  const safeFilePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const absolutePath = path.join(__dirname, safeFilePath);

  // ファイルの存在確認
  fs.stat(absolutePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ファイルが見つかりません。');
      return;
    }

    // 適切なMIMEタイプの取得
    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // ファイルの読み込みと送信
    fs.readFile(absolutePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error: ファイルの読み込みに失敗しました。');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` toio & Switch Controller Server is running!`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
  console.log(`※ ブラウザ（Chrome または Edge）で上記URLを開いてください。`);
  console.log(`※ Ctrl + C でサーバーを停止できます。`);
});
