/**
 * Generate the Chrome Web Store screenshots (1280x800) from source, so the copy
 * lives in git instead of only inside a PNG.
 *
 *   node scripts/gen-store-screenshots.mjs
 *
 * Outputs:
 *   store-previews/tailrd-1-autofill.png
 *   store-previews/tailrd-2-resume.png
 *   store-previews/tailrd-3-cover-letter.png
 *
 * tailrd-4-dashboard.png is NOT generated here: it was already dash-free, so it
 * is left exactly as shipped rather than re-rendered.
 *
 * Same design language as scripts/gen-promo-tiles.mjs (soft white to lavender
 * gradient, heavy near-black headline with one phrase in Tailrd indigo, white
 * product card). Rendered in headless Chromium, then flattened and
 * alpha-stripped with sharp because the store requires 24-bit PNG.
 */
import { chromium } from "playwright";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGO_SRC = path.join(root, "docs", "Logo.jpeg");
// Same lockup crop as scripts/gen-brand-logo.mjs (wing mark + "Tailrd").
const LOGO_CROP = { left: 128, top: 336, width: 770, height: 286 };
const OUT_DIR = path.join(root, "store-previews");

const INK = "#17161d";
const INDIGO = "#5b2ef5";
const BODY = "#55525e";
const FAINT = "#8a8894";
const HL = "#efecfd"; // keyword highlight wash
const LINE = "#eeedf4";

const W = 1280;
const H = 800;

const logoUri = async (heightPx) => {
  const buf = await sharp(LOGO_SRC)
    .extract(LOGO_CROP)
    .flatten({ background: "#ffffff" })
    .resize({ height: heightPx * 2 }) // 2x for crispness
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
};

const baseCss = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    font-family: "Segoe UI", "Inter", Arial, sans-serif;
    background:
      radial-gradient(120% 140% at 100% 115%, #e3dffa 0%, rgba(227,223,250,0) 55%),
      linear-gradient(135deg, #ffffff 0%, #f4f2fc 55%, #e9e6fa 100%);
    color: ${INK};
  }
  .accent { color: ${INDIGO}; }

  /* Shared left-hand copy column */
  .left { position: absolute; left: 76px; top: 168px; width: 540px; }
  .left h1 {
    font-size: 52px; line-height: 1.09; font-weight: 800; letter-spacing: -0.024em;
  }
  .left .sub {
    margin-top: 22px; font-size: 19px; line-height: 1.62; color: ${BODY}; max-width: 462px;
  }
  .foot {
    margin-top: 34px; font-size: 11px; font-weight: 700;
    letter-spacing: 0.12em; color: ${FAINT}; text-transform: uppercase;
  }
  .tile {
    width: 56px; height: 56px; border-radius: 14px; background: ${HL};
    display: flex; align-items: center; justify-content: center;
  }

  /* Shared product card */
  .card {
    position: absolute; background: #fff; border-radius: 18px;
    box-shadow: 0 24px 60px rgba(35, 28, 80, 0.16), 0 2px 8px rgba(35, 28, 80, 0.06);
    overflow: hidden;
  }
  .div { height: 1px; background: ${LINE}; }
  .mark { background: ${HL}; color: ${INDIGO}; border-radius: 5px; padding: 1px 5px; font-weight: 600; }
`;

/* ---------------------------------------------------------------- 1: autofill */
function autofillHtml(logo) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${baseCss}
  .brand { display: flex; align-items: center; }
  .brand img { height: 26px; }
  .left h1 { margin-top: 30px; }
  .marks { margin-top: 18px; display: flex; align-items: center; gap: 26px; }

  /* Faint form skeleton the panel sits on top of */
  .skel { position: absolute; left: 668px; top: 112px; width: 300px; }
  .skel .lbl { height: 8px; border-radius: 4px; background: #e6e4f0; margin-bottom: 10px; }
  .skel .box { height: 34px; border-radius: 8px; background: #fff; border: 1px solid #ecebf4; margin-bottom: 22px; }

  .card { right: 77px; top: 95px; width: 377px; }
  .card-h { display: flex; align-items: center; gap: 9px; padding: 14px 16px; }
  .card-h img { height: 22px; }
  .card-h b { font-size: 15.5px; }
  .icobtn {
    width: 28px; height: 28px; border-radius: 50%; background: #f4f3f9;
    display: flex; align-items: center; justify-content: center; color: #6f6c7d;
  }
  .icobtn.first { margin-left: auto; }
  .job { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
  .job-logo {
    width: 40px; height: 40px; border-radius: 10px; background: ${INK}; color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 19px;
  }
  .job b { display: block; font-size: 15px; }
  .job span { font-size: 12.5px; color: ${BODY}; }
  .pad { padding: 4px 16px 16px; }
  .btn {
    background: ${INDIGO}; color: #fff; border-radius: 999px; font-size: 14.5px;
    font-weight: 700; text-align: center; padding: 13px 0;
    box-shadow: 0 8px 18px rgba(91, 46, 245, 0.32);
  }
  .cap { margin-top: 10px; text-align: center; font-size: 11.5px; color: ${FAINT}; }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 13px 16px;
    font-size: 13.5px; font-weight: 600;
  }
  .row .chev { margin-left: auto; color: #b9b6c6; font-weight: 400; }
  .file { display: flex; align-items: center; padding: 0 16px 8px; font-size: 12px; color: ${BODY}; }
  .chip {
    margin-left: auto; border: 1px solid #e4e2ee; border-radius: 999px;
    font-size: 11px; font-weight: 600; padding: 5px 11px; color: ${INK};
  }
  .ghost {
    margin: 6px 16px 14px; background: ${HL}; color: ${INDIGO}; border-radius: 999px;
    font-size: 12.5px; font-weight: 600; text-align: center; padding: 9px 0;
  }
  .sel {
    margin: 4px 16px 10px; width: 128px; border: 1px solid #e4e2ee; border-radius: 8px;
    font-size: 12.5px; padding: 7px 10px; display: flex; align-items: center;
  }
  .sel .chev { margin-left: auto; color: #9d9aab; }
  .cardfoot { background: #fafaff; text-align: center; padding: 11px 0; }
  .cardfoot a { color: ${INDIGO}; font-size: 12.5px; text-decoration: underline; }
  </style></head><body>
    <div class="skel">
      <div class="lbl" style="width:108px"></div><div class="box"></div>
      <div class="lbl" style="width:82px"></div><div class="box"></div>
      <div class="lbl" style="width:126px"></div><div class="box"></div>
      <div class="lbl" style="width:94px"></div><div class="box"></div>
    </div>

    <div class="left">
      <div class="brand"><img src="${logo}" alt="" /></div>
      <h1>Create the account<br/>&amp; <span class="accent">fill the form</span>,<br/>automatically.</h1>
      <div class="sub">On any application, Tailrd signs you up and completes every field
      from your profile: work authorization, EEO, and the &ldquo;how did you hear about
      us?&rdquo; questions too.</div>
      <div class="foot">Works on every ATS &amp; company career site</div>
      <div class="marks">
        <span style="color:#1f9c6f;font-size:24px;font-weight:700;line-height:1">g</span>
        <span style="color:#000;font-size:19px;line-height:1">&#9650;</span>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff5a5f" stroke-width="1.9"
             stroke-linecap="round" stroke-linejoin="round" aria-label="Airbnb">
          <path d="M12 3.4c1.1 0 1.9.8 2.6 2.2 2 4 4.6 8.3 4.6 10.6 0 2.3-1.6 3.7-3.4 3.7-1.6 0-2.8-.9-3.8-2.3-1 1.4-2.2 2.3-3.8 2.3-1.8 0-3.4-1.4-3.4-3.7 0-2.3 2.6-6.6 4.6-10.6C10.1 4.2 10.9 3.4 12 3.4Z"/>
        </svg>
        <span style="color:#ff9900;font-size:24px;font-weight:700;line-height:1">a</span>
        <span style="color:#111;font-size:17px;font-weight:700;line-height:1;border:1.5px solid #16151b;border-radius:5px;padding:2px 6px">N</span>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        <img src="${logo}" alt="" />
        <span class="icobtn first">&#9881;</span>
        <span class="icobtn">&#10005;</span>
      </div>
      <div class="div"></div>
      <div class="job">
        <div class="job-logo">&#9650;</div>
        <div><b>Vercel</b><span>Senior Frontend Engineer</span></div>
      </div>
      <div class="pad">
        <div class="btn">Account Creation &amp; Autofill</div>
        <div class="cap">18 fields ready to fill on this page</div>
      </div>
      <div class="div"></div>
      <div class="row">
        <svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6f6c7d"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>
        </svg>
        Your Autofill Information <span class="chev">&#8250;</span>
      </div>
      <div class="div"></div>
      <div class="row">
        <svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6f6c7d"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>
        </svg>
        Upload Resume
      </div>
      <div class="file">Alex_Rivera_Resume.pdf <span class="chip">Change</span></div>
      <div class="ghost">&#10022;&nbsp; Tailor résumé for this job</div>
      <div class="div"></div>
      <div class="row">
        <svg class="ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6f6c7d"
             stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>
        </svg>
        Cover Letter
      </div>
      <div class="sel">Professional <span class="chev">&#8964;</span></div>
      <div class="ghost">&#10022;&nbsp; Generate cover letter</div>
      <div class="cardfoot"><a>Open Dashboard</a></div>
    </div>
  </body></html>`;
}

/* ------------------------------------------------------------------ 2: resume */
function resumeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${baseCss}
  .left { top: 200px; }
  .left h1 { margin-top: 30px; }
  .card { right: 164px; top: 167px; width: 450px; padding: 22px 24px 0; }
  .nm { font-size: 20px; font-weight: 700; max-width: 300px; }
  .meta { font-size: 12px; color: ${BODY}; margin-top: 3px; }
  .sect { margin-top: 16px; font-size: 10px; font-weight: 700; letter-spacing: 0.09em; color: ${INDIGO}; }
  .p { margin-top: 6px; font-size: 12.5px; line-height: 1.55; color: #2f2d38; }
  .exp-h { display: flex; align-items: baseline; margin-top: 8px; }
  .exp-h b { font-size: 12.5px; }
  .exp-h span { margin-left: auto; font-size: 11px; color: ${FAINT}; }
  ul { margin-top: 6px; padding-left: 14px; }
  li { font-size: 12.5px; line-height: 1.5; color: #2f2d38; margin-bottom: 5px; }
  li::marker { color: #c6c3d2; }
  .pills { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 7px; }
  .pill { background: ${HL}; color: ${INDIGO}; border-radius: 6px; font-size: 11.5px; font-weight: 600; padding: 5px 9px; }
  .pill.plain { background: #f4f3f9; color: #4a4855; }
  .attach {
    margin: 18px 0 22px; background: ${INDIGO}; color: #fff; text-align: center;
    border-radius: 10px; font-size: 14px; font-weight: 700; padding: 15px 0;
    box-shadow: 0 8px 18px rgba(91, 46, 245, 0.28);
  }
  /* Score gauge, sits in the card's top-right corner */
  .gauge { position: absolute; right: 22px; top: 22px; width: 96px; text-align: center; }
  .gauge svg { display: block; }
  .gauge .num { position: absolute; left: 0; right: 0; top: 27px; font-size: 23px; font-weight: 700; }
  .gauge .lab { margin-top: 3px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; color: #17994f; }
  </style></head><body>
    <div class="left">
      <div class="tile">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${INDIGO}" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
        </svg>
      </div>
      <h1>Your résumé,<br/>rewritten to<br/><span class="accent">match the posting</span>.</h1>
      <div class="sub">Tailrd weaves in the exact skills the job asks for, sharpens your
      bullet points, and scores the result against the description, then attaches it
      where you apply.</div>
    </div>

    <div class="card">
      <div class="gauge">
        <svg width="96" height="60" viewBox="0 0 96 60">
          <path d="M10 54 A38 38 0 0 1 86 54" fill="none" stroke="#eceaf4" stroke-width="7" stroke-linecap="round"/>
          <path d="M10 54 A38 38 0 0 1 78 30" fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round"/>
          <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stop-color="#f5b800"/><stop offset="100%" stop-color="#17994f"/>
          </linearGradient></defs>
          <circle cx="80" cy="27" r="4.5" fill="#fff" stroke="${INK}" stroke-width="2"/>
        </svg>
        <div class="num">9.2</div>
        <div class="lab">EXCELLENT</div>
      </div>

      <div class="nm">Alex Rivera</div>
      <div class="meta">Senior Frontend Engineer &middot; San Francisco, CA</div>

      <div class="sect">SUMMARY</div>
      <div class="p" style="max-width:300px">Frontend engineer with 7 years building
        <span class="mark">React</span> and <span class="mark">TypeScript</span> apps at
        scale, focused on <span class="mark">design systems</span> and
        <span class="mark">accessibility</span>.</div>

      <div class="sect">EXPERIENCE</div>
      <div class="exp-h"><b>Senior Frontend Engineer, Vercel</b><span>2021 &ndash; Present</span></div>
      <ul>
        <li>Led the migration of a legacy dashboard to <span class="mark">Next.js</span>, cutting page-load time by 42%.</li>
        <li>Built a reusable <span class="mark">component library</span> in <span class="mark">Storybook</span>, adopted by 6 product teams.</li>
        <li>Shipped <span class="mark">WCAG 2.1 AA</span> fixes across the checkout flow, lifting task completion 18%.</li>
      </ul>

      <div class="sect">SKILLS</div>
      <div class="pills">
        <span class="pill">React</span><span class="pill">TypeScript</span><span class="pill">Next.js</span>
        <span class="pill plain">GraphQL</span><span class="pill">Accessibility</span>
        <span class="pill plain">Jest</span><span class="pill plain">CI/CD</span>
      </div>

      <div class="attach">&#10003;&nbsp; Attach to application</div>
    </div>
  </body></html>`;
}

/* ------------------------------------------------------------ 3: cover letter */
function coverLetterHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${baseCss}
  .left { top: 216px; }
  .left h1 { margin-top: 30px; }
  .card { right: 164px; top: 167px; width: 450px; padding: 22px 24px 20px; }
  .nm { font-size: 17px; font-weight: 700; }
  .meta { font-size: 10.5px; color: ${FAINT}; margin-top: 3px; }
  .p { margin-top: 14px; font-size: 12.5px; line-height: 1.62; color: #2f2d38; }
  .sign { margin-top: 14px; font-size: 12.5px; line-height: 1.62; color: #2f2d38; }
  .tone { margin-top: 18px; font-size: 10px; font-weight: 700; letter-spacing: 0.09em; color: ${FAINT}; }
  .pills { margin-top: 10px; display: flex; gap: 10px; }
  .pill { border-radius: 999px; font-size: 12px; font-weight: 600; padding: 7px 14px; border: 1px solid #e4e2ee; color: #4a4855; }
  .pill.on { background: ${HL}; color: ${INDIGO}; border-color: transparent; }
  </style></head><body>
    <div class="left">
      <div class="tile">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${INDIGO}" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>
        </svg>
      </div>
      <h1>A cover letter<br/><span class="accent">written for this role</span>,<br/>not a template.</h1>
      <div class="sub">Tailrd drafts it from your résumé and the job posting, in the tone
      you pick. Read it, tweak a line, then attach or download.</div>
    </div>

    <div class="card">
      <div class="nm">Alex Rivera</div>
      <div class="meta">alex.rivera@email.com &middot; San Francisco, CA &middot; linkedin.com/in/alexrivera</div>

      <div class="p">Dear Hiring Team at Ramp,</div>
      <div class="p">I&rsquo;m excited to apply for the <span class="mark">Senior Frontend Engineer</span>
        role. Over the past seven years I&rsquo;ve shipped fast, accessible interfaces with
        <span class="mark">React</span> and <span class="mark">TypeScript</span>, most recently
        rebuilding Vercel&rsquo;s billing dashboard, where I cut load time by 42% and drove a
        measurable lift in conversion.</div>
      <div class="p">Ramp&rsquo;s focus on turning finance busywork into something effortless is
        exactly the kind of product problem I love. I&rsquo;d bring the same obsession with speed,
        polish, and design systems to your team.</div>

      <div class="sign">Warm regards,<br/>Alex Rivera</div>

      <div class="tone">ADJUST TONE</div>
      <div class="pills">
        <span class="pill on">Professional</span>
        <span class="pill">Enthusiastic</span>
        <span class="pill">Concise</span>
      </div>
    </div>
  </body></html>`;
}

async function shoot(browser, html, outName) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "networkidle" });
  const raw = await page.screenshot({ type: "png" });
  await page.close();
  const out = path.join(OUT_DIR, outName);
  await sharp(raw)
    .resize(W, H)
    .flatten({ background: "#ffffff" })
    .removeAlpha() // store requires 24-bit, no alpha
    .png({ compressionLevel: 9 })
    .toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`${outName}: ${meta.width}x${meta.height}, alpha=${meta.hasAlpha}`);
}

const browser = await chromium.launch();
const logo = await logoUri(26);
await shoot(browser, autofillHtml(logo), "tailrd-1-autofill.png");
await shoot(browser, resumeHtml(), "tailrd-2-resume.png");
await shoot(browser, coverLetterHtml(), "tailrd-3-cover-letter.png");
await browser.close();
