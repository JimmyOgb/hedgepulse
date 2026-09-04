import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error loading dashboard");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`=====================================================================`);
  console.log(`   HedgePulse AI - Operator Cockpit Server Started                  `);
  console.log(`   Dashboard URL: http://localhost:${PORT}                           `);
  console.log(`   Press Ctrl+C to stop the server                                  `);
  console.log(`=====================================================================`);
});
