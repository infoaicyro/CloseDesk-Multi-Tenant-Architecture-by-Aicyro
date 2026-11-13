import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const mdPath = path.resolve("docs/CD03_TENANT_ISOLATION_AND_SECRET_PROTECTION.md");
const outDir = path.resolve("Drive docs");
const outPdfPath = path.join(outDir, "CD03_TENANT_ISOLATION_AND_SECRET_PROTECTION.pdf");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const mdContent = fs.readFileSync(mdPath, "utf8");

// Simple markdown-to-html converter tailored for our report
function renderMarkdown(md) {
  let html = md;

  // Escape HTML entities in code blocks first
  const codeBlocks = [];
  html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `___CODE_BLOCK_${codeBlocks.length}___`;
    const escapedCode = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    codeBlocks.push(`<pre><code class="language-${lang}">${escapedCode}</code></pre>`);
    return placeholder;
  });

  // Inline code
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (match, code) => {
    const placeholder = `___INLINE_CODE_${inlineCodes.length}___`;
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${escaped}</code>`);
    return placeholder;
  });

  // Alerts
  html = html.replace(/> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n> (.*)/g, (match, type, text) => {
    return `<div class="alert alert-${type.toLowerCase()}"><strong>${type}:</strong> ${text}</div>`;
  });

  // Headers
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");

  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Tables
  const lines = html.split("\n");
  const processedLines = [];
  let inTable = false;
  let tableHtml = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      if (!inTable) {
        inTable = true;
        tableHtml = "<table>\n";
      }
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^:?-+:?$/.test(c))) {
        // separator line, skip
        continue;
      }
      if (!tableHtml.includes("<tbody>") && !tableHtml.includes("</th>")) {
        tableHtml += "<thead><tr>" + cells.map(c => `<th>${c}</th>`).join("") + "</tr></thead>\n<tbody>\n";
      } else {
        tableHtml += "<tr>" + cells.map(c => `<td>${c}</td>`).join("") + "</tr>\n";
      }
    } else {
      if (inTable) {
        tableHtml += "</tbody>\n</table>\n";
        processedLines.push(tableHtml);
        inTable = false;
        tableHtml = "";
      }
      processedLines.push(lines[i]);
    }
  }
  if (inTable) {
    tableHtml += "</tbody>\n</table>\n";
    processedLines.push(tableHtml);
  }
  html = processedLines.join("\n");

  // Horizontal rules
  html = html.replace(/^---$/gim, "<hr/>");

  // Lists
  html = html.replace(/^\s*-\s+(.*$)/gim, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/gim, "<ul>$1</ul>");

  // Paragraphs
  html = html.split("\n\n").map(para => {
    para = para.trim();
    if (
      para.startsWith("<h") ||
      para.startsWith("<table") ||
      para.startsWith("<pre") ||
      para.startsWith("<ul") ||
      para.startsWith("<div") ||
      para.startsWith("<hr") ||
      para.startsWith("___CODE_BLOCK_")
    ) {
      return para;
    }
    if (para.length > 0) {
      return `<p>${para.replace(/\n/g, "<br/>")}</p>`;
    }
    return "";
  }).join("\n\n");

  // Restore code blocks and inline code
  codeBlocks.forEach((cb, idx) => {
    html = html.replace(`___CODE_BLOCK_${idx}___`, cb);
  });
  inlineCodes.forEach((ic, idx) => {
    html = html.replace(`___INLINE_CODE_${idx}___`, ic);
  });

  return html;
}

const styledHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CD03 Security Audit & Implementation Report</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm 18mm 16mm;
      @bottom-right {
        content: counter(page);
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.55;
      color: #1a202c;
      background: #ffffff;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 20pt;
      color: #0f172a;
      border-bottom: 2.5px solid #2563eb;
      padding-bottom: 8px;
      margin-top: 0;
      margin-bottom: 16px;
      font-weight: 700;
    }
    h2 {
      font-size: 14pt;
      color: #1e293b;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 6px;
      margin-top: 24px;
      margin-bottom: 12px;
      font-weight: 600;
      page-break-after: avoid;
    }
    h3 {
      font-size: 11.5pt;
      color: #334155;
      margin-top: 18px;
      margin-bottom: 8px;
      font-weight: 600;
      page-break-after: avoid;
    }
    p, li {
      color: #334155;
    }
    ul {
      margin-top: 6px;
      margin-bottom: 12px;
      padding-left: 20px;
    }
    li {
      margin-bottom: 4px;
    }
    hr {
      border: 0;
      border-top: 1px solid #e2e8f0;
      margin: 22px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 9pt;
      page-break-inside: auto;
    }
    tr {
      page-break-inside: avoid;
      page-break-after: auto;
    }
    th {
      background-color: #0f172a;
      color: #ffffff;
      font-weight: 600;
      text-align: left;
      padding: 8px 10px;
      border: 1px solid #0f172a;
    }
    td {
      padding: 7px 10px;
      border: 1px solid #e2e8f0;
      vertical-align: top;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
    pre {
      background-color: #0f172a;
      color: #f1f5f9;
      padding: 12px;
      border-radius: 6px;
      font-size: 8.5pt;
      line-height: 1.45;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 12px 0;
      page-break-inside: avoid;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 9pt;
      background-color: #f1f5f9;
      color: #0f172a;
      padding: 2px 5px;
      border-radius: 4px;
    }
    pre code {
      background: none;
      color: inherit;
      padding: 0;
      font-size: 8.5pt;
    }
    .alert {
      padding: 10px 14px;
      border-radius: 6px;
      margin: 14px 0;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    .alert-important {
      background-color: #eff6ff;
      border-left: 4px solid #2563eb;
      color: #1e40af;
    }
    .alert-warning {
      background-color: #fffbeb;
      border-left: 4px solid #f59e0b;
      color: #92400e;
    }
    .header-badge {
      display: inline-block;
      background: #10b981;
      color: #ffffff;
      font-size: 8pt;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      margin-left: 10px;
      vertical-align: middle;
    }
    .meta-box {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 20px;
      font-size: 9.5pt;
    }
  </style>
</head>
<body>
  ${renderMarkdown(mdContent)}
</body>
</html>
`;

async function main() {
  console.log("Launching headless browser via Puppeteer Core...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(styledHtml, { waitUntil: "networkidle0" });

    console.log(`Rendering PDF to ${outPdfPath}...`);
    await page.pdf({
      path: outPdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "16mm",
        bottom: "16mm",
        left: "14mm",
        right: "14mm",
      },
    });

    const stats = fs.statSync(outPdfPath);
    console.log(`✅ Successfully generated CD03 PDF Report!`);
    console.log(`   File: ${outPdfPath}`);
    console.log(`   Size: ${stats.size} bytes (${(stats.size / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Failed to generate PDF:", err);
  process.exit(1);
});
