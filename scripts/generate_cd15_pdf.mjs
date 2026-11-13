import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function getBrowserPath() {
  if (fs.existsSync(CHROME_PATH)) return CHROME_PATH;
  if (fs.existsSync(EDGE_PATH)) return EDGE_PATH;
  throw new Error("Neither Chrome nor Edge found on host.");
}

const mdPath = path.resolve("docs/CD15_DEPLOYMENT_RECOVERY_AND_MONITORING.md");
const outDir = path.resolve("Drive docs");
const outCdDir = path.resolve("Drive docs/CD");
const outPdfPath = path.join(outDir, "CD15_DEPLOYMENT_RECOVERY_AND_MONITORING.pdf");
const outCdPdfPath = path.join(outCdDir, "CD15 DEPLOYMENT RECOVERY AND MONITORING.pdf");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}
if (!fs.existsSync(outCdDir)) {
  fs.mkdirSync(outCdDir, { recursive: true });
}

const mdContent = fs.readFileSync(mdPath, "utf8");

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
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      if (!tableHtml.includes("<tbody>") && !tableHtml.includes("</th>")) {
        tableHtml += "<thead><tr>" + cells.map((c) => `<th>${c}</th>`).join("") + "</tr></thead>\n<tbody>\n";
      } else {
        tableHtml += "<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>\n";
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
  html = html.replace(/^\s*-\s+(.*)$/gim, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");

  // Paragraphs
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<table") ||
        trimmed.startsWith("<pre") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<div") ||
        trimmed.startsWith("<hr") ||
        trimmed.startsWith("___CODE_BLOCK_")
      ) {
        return trimmed;
      }
      return `<p>${trimmed}</p>`;
    })
    .join("\n\n");

  // Restore inline codes
  inlineCodes.forEach((codeHtml, idx) => {
    html = html.replace(`___INLINE_CODE_${idx}___`, codeHtml);
  });

  // Restore code blocks
  codeBlocks.forEach((codeHtml, idx) => {
    html = html.replace(`___CODE_BLOCK_${idx}___`, codeHtml);
  });

  return html;
}

const styledHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CD15 Deployment Recovery, Monitoring, and Incident Runbook Report</title>
  <style>
    @page {
      size: A4;
      margin: 16mm 14mm 16mm 14mm;
      @bottom-right {
        content: counter(page) " / " counter(pages);
        font-size: 8pt;
        color: #64748b;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 9.5pt;
      line-height: 1.5;
      color: #1e293b;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 19pt;
      font-weight: 800;
      color: #0f172a;
      border-bottom: 2px solid #0284c7;
      padding-bottom: 8px;
      margin-top: 0;
      margin-bottom: 12px;
      page-break-after: avoid;
    }
    h2 {
      font-size: 13pt;
      font-weight: 700;
      color: #0369a1;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 5px;
      margin-top: 22px;
      margin-bottom: 10px;
      page-break-after: avoid;
    }
    h3 {
      font-size: 11pt;
      font-weight: 600;
      color: #0f172a;
      margin-top: 16px;
      margin-bottom: 6px;
      page-break-after: avoid;
    }
    p {
      margin-top: 0;
      margin-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 8.5pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 9px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background-color: #f1f5f9;
      font-weight: 600;
      color: #0f172a;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }
    pre {
      background-color: #0f172a;
      color: #f8fafc;
      padding: 10px 14px;
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 7.5pt;
      line-height: 1.45;
      overflow-x: auto;
      margin: 10px 0;
      page-break-inside: avoid;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 8.5pt;
      background-color: #f1f5f9;
      padding: 2px 4px;
      border-radius: 4px;
      color: #0f172a;
    }
    pre code {
      background-color: transparent;
      padding: 0;
      color: #f8fafc;
    }
    ul {
      margin-top: 0;
      margin-bottom: 10px;
      padding-left: 20px;
    }
    li {
      margin-bottom: 4px;
    }
    hr {
      border: 0;
      border-top: 1px solid #e2e8f0;
      margin: 18px 0;
    }
    .alert {
      padding: 10px 14px;
      margin: 12px 0;
      border-left: 4px solid;
      border-radius: 4px;
      font-size: 9pt;
    }
    .alert-note {
      background-color: #f0f9ff;
      border-color: #0284c7;
      color: #0369a1;
    }
    .alert-tip {
      background-color: #f0fdf4;
      border-color: #16a34a;
      color: #15803d;
    }
    .alert-important {
      background-color: #faf5ff;
      border-color: #9333ea;
      color: #7e22ce;
    }
    .alert-warning {
      background-color: #fffbeb;
      border-color: #d97706;
      color: #b45309;
    }
    .alert-caution {
      background-color: #fef2f2;
      border-color: #dc2626;
      color: #b91c1c;
    }
  </style>
</head>
<body>
${renderMarkdown(mdContent)}
</body>
</html>
`;

async function main() {
  const browserPath = getBrowserPath();
  console.log(`Launching headless browser from ${browserPath}...`);
  const browser = await puppeteer.launch({
    executablePath: browserPath,
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

    console.log(`Rendering PDF to ${outCdPdfPath}...`);
    await page.pdf({
      path: outCdPdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "16mm",
        bottom: "16mm",
        left: "14mm",
        right: "14mm",
      },
    });

    const stats1 = fs.statSync(outPdfPath);
    const stats2 = fs.statSync(outCdPdfPath);
    console.log(`✅ Successfully generated CD15 PDF Reports!`);
    console.log(`   File 1: ${outPdfPath} (${(stats1.size / 1024).toFixed(1)} KB)`);
    console.log(`   File 2: ${outCdPdfPath} (${(stats2.size / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Failed to generate PDF:", err);
  process.exit(1);
});
