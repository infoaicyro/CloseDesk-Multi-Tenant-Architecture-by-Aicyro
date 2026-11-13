// scripts/generate_e2e_page.js
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\moids\\.gemini\\antigravity\\brain\\c4af3c56-d127-41a6-99e9-8ebaa677fba1';
const REPORT_FILE = path.join(ARTIFACT_DIR, 'e2e_execution_report.json');
const HTML_FILE = path.join(ARTIFACT_DIR, 'e2e_visual_dashboard.html');
const TARGET_PAGE = path.join(__dirname, '..', 'src', 'pages', 'e2e-report.jsx');

const rawHtml = fs.readFileSync(HTML_FILE, 'utf8');

// Create a React page that dangerously sets the self-contained HTML
const pageCode = `// src/pages/e2e-report.jsx
import Head from "next/head";

export default function E2EReportPage() {
  return (
    <>
      <Head>
        <title>CloseDesk E2E Automated Visual QA Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>
      <div
        style={{ minHeight: "100vh", width: "100%", background: "#090d16" }}
        dangerouslySetInnerHTML={{ __html: ${JSON.stringify(rawHtml)} }}
      />
    </>
  );
}
`;

fs.writeFileSync(TARGET_PAGE, pageCode, 'utf8');
console.log('Generated src/pages/e2e-report.jsx successfully');
