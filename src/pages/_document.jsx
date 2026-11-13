// src/pages/_document.jsx
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* --- Google Search Console Verification --- */}
        <meta name="google-site-verification" content="RU9Mmnrs0B-77ZemnbfT7X6KPyc9AF_AszHUc8m9mYo" />
      </Head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var path = window.location.pathname || "";
                  if (path.indexOf("/lg") === 0) return;
                  var theme = localStorage.getItem("closeDesk-theme") || "light";
                  if (theme === "dark") {
                    document.documentElement.setAttribute("data-theme", "dark");
                  } else {
                    document.documentElement.removeAttribute("data-theme");
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}