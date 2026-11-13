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

const mdPath = path.resolve("docs/DEBATE_RESOLUTION_AND_SPECIALIST_REVIEWS.md");
const outDir = path.resolve("Drive docs");
const outCdDir = path.resolve("Drive docs/CD");
const outDocsDir = path.resolve("docs");

const outPdfPath1 = path.join(outDir, "DEBATE_RESOLUTION_AND_SPECIALIST_REVIEWS.pdf");
const outPdfPath2 = path.join(outCdDir, "DEBATE RESOLUTION AND SPECIALIST REVIEWS.pdf");
const outPdfPath3 = path.join(outDocsDir, "DEBATE_RESOLUTION_AND_SPECIALIST_REVIEWS.pdf");

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(outCdDir)) fs.mkdirSync(outCdDir, { recursive: true });

const mdContent = fs.readFileSync(mdPath, "utf8");

function renderMarkdown(md) {
  let html = md;

  // Mermaid diagrams
  const mermaidBlocks = [];
  html = html.replace(/```mermaid\n([\s\S]*?)```/g, (match, code) => {
    const placeholder = `___MERMAID_BLOCK_${mermaidBlocks.length}___`;
    mermaidBlocks.push(`<div class="mermaid">${code.trim()}</div>`);
    return placeholder;
  });

  // Escape HTML entities in code blocks
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
  const listLines = html.split("\n");
  const processedLists = [];
  let inUl = false;
  for (let i = 0; i < listLines.length; i++) {
    const line = listLines[i];
    const match = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (match) {
      if (!inUl) {
        inUl = true;
        processedLists.push("<ul>");
      }
      processedLists.push(`  <li>${match[2]}</li>`);
    } else {
      if (inUl) {
        processedLists.push("</ul>");
        inUl = false;
      }
      processedLists.push(line);
    }
  }
  if (inUl) {
    processedLists.push("</ul>");
  }
  html = processedLists.join("\n");

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
        trimmed.startsWith("___CODE_BLOCK_") ||
        trimmed.startsWith("___MERMAID_BLOCK_")
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

  // Restore mermaid blocks
  mermaidBlocks.forEach((mHtml, idx) => {
    html = html.replace(`___MERMAID_BLOCK_${idx}___`, mHtml);
  });

  return html;
}

const styledHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CloseDesk: Debate Resolution, Specialist Reviews & Scope Deferral Specification</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      mermaid.initialize({
        startOnLoad: true,
        theme: "neutral",
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" }
      });
    });
  </script>
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
      font-size: 9.2pt;
      line-height: 1.5;
      color: #1e293b;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
    }
    h1 {
      font-size: 18pt;
      font-weight: 800;
      color: #0f172a;
      border-bottom: 2.5px solid #0284c7;
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
      font-size: 10.5pt;
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
      margin: 14px 0;
      font-size: 8.2pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 8px;
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
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 7.5pt;
      line-height: 1.45;
      overflow-x: auto;
      margin: 12px 0;
      page-break-inside: avoid;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 8.2pt;
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
    .mermaid {
      display: flex;
      justify-content: center;
      margin: 16px 0;
      page-break-inside: avoid;
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

    // Allow Mermaid SVG rendering to complete
    await page.evaluate(async () => {
      if (window.mermaid) {
        await window.mermaid.run();
      }
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    console.log(`Rendering PDF to ${outPdfPath1}...`);
    await page.pdf({
      path: outPdfPath1,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });

    console.log(`Rendering PDF to ${outPdfPath2}...`);
    await page.pdf({
      path: outPdfPath2,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });

    console.log(`Rendering PDF to ${outPdfPath3}...`);
    await page.pdf({
      path: outPdfPath3,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
    });

    const s1 = fs.statSync(outPdfPath1);
    const s2 = fs.statSync(outPdfPath2);
    const s3 = fs.statSync(outPdfPath3);

    console.log(`✅ Successfully generated Debate Resolution & Specialist Reviews PDFs!`);
    console.log(`   Destination 1: ${outPdfPath1} (${(s1.size / 1024).toFixed(1)} KB)`);
    console.log(`   Destination 2: ${outPdfPath2} (${(s2.size / 1024).toFixed(1)} KB)`);
    console.log(`   Destination 3: ${outPdfPath3} (${(s3.size / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Failed to generate PDF:", err);
  process.exit(1);
});
