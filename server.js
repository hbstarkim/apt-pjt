/* 의존성 없는 정적 파일 서버 (Node 기본 모듈만 사용)
   사용: node server.js   →  http://localhost:8765
   OCR(웹 워커) 등은 file:// 에서 막히므로 이 서버로 띄워 사용합니다. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || "8765", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/gzip",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const server = http.createServer(function (req, res) {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.readFile(filePath, function (err, data) {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not Found: " + urlPath); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end("Server error");
  }
});

function listen(port, tries) {
  server.once("error", function (e) {
    if (e.code === "EADDRINUSE" && tries > 0) { listen(port + 1, tries - 1); }
    else { console.error("서버 시작 실패:", e.message); process.exit(1); }
  });
  server.listen(port, function () {
    const url = "http://localhost:" + port + "/";
    console.log("아파트 평면도 시뮬레이터 서버가 실행되었습니다.");
    console.log("브라우저에서 열기: " + url);
    console.log("종료하려면 이 창에서 Ctrl + C 를 누르세요.");
  });
}
listen(PORT, 10);
