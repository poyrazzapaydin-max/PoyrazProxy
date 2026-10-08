const express = require("express");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  "/proxy",
  express.urlencoded({ extended: true, limit: "5mb" }),
  express.json({ limit: "5mb" })
);

// ---------------------------------------------------------------------------
// Landing-Page (direkt hier eingebettet -> keine extra Datei nötig)
// ---------------------------------------------------------------------------
const LANDING = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Web Proxy</title>
<style>
:root{--bg:#0b0f1a;--card:#141a2b;--accent:#5b8cff;--text:#e8ecf5;--muted:#8a93a8;--border:#232c44}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#182142,var(--bg));color:var(--text)}
.card{width:100%;max-width:560px;background:var(--card);border:1px solid var(--border);
border-radius:18px;padding:40px 32px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:28px;letter-spacing:-.5px}
p.sub{margin:0 0 28px;color:var(--muted);font-size:15px}
form{display:flex;gap:10px}
input{flex:1;padding:14px 16px;font-size:16px;color:var(--text);background:#0e1322;
border:1px solid var(--border);border-radius:12px;outline:none}
input:focus{border-color:var(--accent)}
button{padding:0 22px;font-size:16px;font-weight:600;color:#fff;background:var(--accent);
border:none;border-radius:12px;cursor:pointer}
button:hover{filter:brightness(1.08)}
.hint{margin-top:18px;font-size:13px;color:var(--muted)}
</style></head><body>
<div class="card">
<h1>Web Proxy</h1>
<p class="sub">URL eingeben, Seite wird über diesen Server geladen.</p>
<form id="f">
<input id="url" type="text" placeholder="z. B. example.com oder https://de.wikipedia.org" autocomplete="off" autofocus/>
<button type="submit">Los</button>
</form>
<div class="hint">Funktioniert am besten mit normalen Webseiten. Stark JS-/App-lastige Seiten koennen eingeschraenkt sein.</div>
</div>
<script>
document.getElementById("f").addEventListener("submit",function(e){
e.preventDefault();var v=document.getElementById("url").value.trim();if(!v)return;
if(!/^https?:\\/\\//i.test(v))v="https://"+v;
window.location.href="/proxy?u="+encodeURIComponent(v);});
</script>
</body></html>`;

app.get("/", (_req, res) => res.type("html").send(LANDING));

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function toProxy(absoluteUrl) {
  return "/proxy?u=" + encodeURIComponent(absoluteUrl);
}

const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "strict-transport-security",
  "set-cookie",
]);

// ---------------------------------------------------------------------------
// Proxy-Route
// ---------------------------------------------------------------------------
app.all("/proxy", async (req, res) => {
  const target = req.query.u;
  if (!target) return res.status(400).send("Fehlender Parameter: u");

  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!/^https?:$/.test(targetUrl.protocol)) throw new Error("nur http/https");
  } catch {
    return res.status(400).send("Ungueltige URL");
  }

  try {
    const init = {
      method: req.method,
      headers: {
        "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
        accept: req.headers["accept"] || "*/*",
        "accept-language": req.headers["accept-language"] || "de,en;q=0.9",
      },
      redirect: "manual",
    };

    if (req.method === "POST") {
      if (req.is("application/x-www-form-urlencoded")) {
        init.headers["content-type"] = "application/x-www-form-urlencoded";
        init.body = new URLSearchParams(req.body).toString();
      } else if (req.is("application/json")) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body);
      }
    }

    const upstream = await fetch(targetUrl.href, init);

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = new URL(loc, targetUrl.href).href;
        return res.redirect(toProxy(abs));
      }
    }

    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });

    const contentType = upstream.headers.get("content-type") || "";
    res.status(upstream.status);

    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      return res.send(rewriteHtml(html, targetUrl.href));
    }
    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      return res.send(rewriteCss(css, targetUrl.href));
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    return res.status(502).send("Proxy-Fehler: " + e.message);
  }
});

// ---------------------------------------------------------------------------
// HTML umschreiben
// ---------------------------------------------------------------------------
function rewriteHtml(html, base) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const rewriteAttr = (el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    if (/^(data:|javascript:|mailto:|tel:|about:|blob:|#)/i.test(val)) return;
    try {
      $(el).attr(attr, toProxy(new URL(val, base).href));
    } catch {}
  };

  $("[href]").each((_, el) => rewriteAttr(el, "href"));
  $("[src]").each((_, el) => rewriteAttr(el, "src"));
  $("[action]").each((_, el) => rewriteAttr(el, "action"));
  $("[poster]").each((_, el) => rewriteAttr(el, "poster"));
  $("[data-src]").each((_, el) => rewriteAttr(el, "data-src"));

  $("[srcset]").each((_, el) => {
    const parts = ($(el).attr("srcset") || "").split(",").map((p) => {
      const seg = p.trim().split(/\s+/);
      try {
        return toProxy(new URL(seg[0], base).href) + (seg[1] ? " " + seg[1] : "");
      } catch {
        return p;
      }
    });
    $(el).attr("srcset", parts.join(", "));
  });

  $("[style]").each((_, el) => $(el).attr("style", rewriteCss($(el).attr("style"), base)));
  $("style").each((_, el) => $(el).html(rewriteCss($(el).html() || "", base)));
  $("base").remove();

  return $.html();
}

// ---------------------------------------------------------------------------
// CSS umschreiben
// ---------------------------------------------------------------------------
function rewriteCss(css, base) {
  if (!css) return css;
  return css
    .replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (m, u) => {
      if (/^(data:|about:|#)/i.test(u)) return m;
      try {
        return `url("${toProxy(new URL(u, base).href)}")`;
      } catch {
        return m;
      }
    })
    .replace(/@import\s+['"]([^'"]+)['"]/gi, (m, u) => {
      try {
        return `@import "${toProxy(new URL(u, base).href)}"`;
      } catch {
        return m;
      }
    });
}

app.listen(PORT, () => console.log(`Proxy laeuft auf Port ${PORT}`));
