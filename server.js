require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ────────────────────────────────────────────────────
const PAYLOAD_BASE = process.env.PAYLOAD_BASE_URL || 'https://www.vitalrecordsonline.com';
const PAYLOAD_API  = process.env.PAYLOAD_API_PATH  || '/api-cms';
const PAYLOAD_URL  = `${PAYLOAD_BASE}${PAYLOAD_API}`;
const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN  || '';
const SEMRUSH_KEY  = process.env.SEMRUSH_API_KEY   || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY  || '';
const PORT         = process.env.PORT || 3847;

// ─── Persistent Data Directory ────────────────────────────────
// Use DATA_PATH env var (Railway Volume mount) or fall back to local ./data
const DATA_ROOT = process.env.DATA_PATH || path.join(__dirname, 'data');

// ─── Runtime Settings (overridable from UI) ───────────────────
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveSettings(s) {
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
function getSetting(key, envFallback) {
  const s = loadSettings();
  return s[key] || envFallback || '';
}

let payloadToken = null;
let tokenExpiry  = 0;

// ─── Session Authentication ────────────────────────────────────
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

const CREDENTIALS = {
  'guillaume': 'xK9#mPvR!2026q',
  'marketing': 'Wt7$nLcB@seoMk',
  'developer': 'Jf3&hZdQ*dev08',
  'viewer': 'Rn5!bYgA#view2'
};

const sessions = {}; // { token: { username, createdAt } }

function generateToken() {
  return crypto.randomUUID();
}

function createSession(username) {
  const token = generateToken();
  sessions[token] = { username, createdAt: Date.now() };
  return token;
}

function validateSession(token) {
  if (!token || !sessions[token]) return null;
  const session = sessions[token];
  if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
    delete sessions[token];
    return null;
  }
  return session;
}

// Auth middleware for /api/* routes (except /api/login)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.slice(7);
  const session = validateSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
  req.session = session;
  next();
}

// ─── Persistent Storage ────────────────────────────────────────────
const DATA_DIR  = DATA_ROOT;
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const HISTORY_DIR  = path.join(DATA_DIR, 'history');
const SERP_HISTORY_FILE = path.join(DATA_DIR, 'serp-history.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}
function savePageResult(key, data) {
  const all = loadResults();
  all[key] = data;
  saveResults(all);
  // Also save individual page file for easy access
  const safeKey = key.replace(/\//g, '_');
  fs.writeFileSync(path.join(DATA_DIR, `${safeKey}.json`), JSON.stringify(data, null, 2));
}
function snapshotHistory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const src = RESULTS_FILE;
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(HISTORY_DIR, `results_${stamp}.json`));
  }
}

// SERP history tracking
function loadSerpHistory() {
  try { return JSON.parse(fs.readFileSync(SERP_HISTORY_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveSerpHistory(data) {
  fs.writeFileSync(SERP_HISTORY_FILE, JSON.stringify(data, null, 2));
}

function recordSerpPosition(url, keywords) {
  const history = loadSerpHistory();
  const today = new Date().toISOString().split('T')[0];

  if (!history[url]) history[url] = {};
  if (!history[url][today]) history[url][today] = [];

  history[url][today] = keywords.map(k => ({
    keyword: k.keyword,
    position: k.position,
    volume: k.volume,
    traffic: k.traffic
  }));

  saveSerpHistory(history);
}

function getSerpMovement(url, keywords) {
  const history = loadSerpHistory();
  if (!history[url]) return { dailyChange: 0, weeklyChange: 0, keywords };

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const todayData = history[url][today] || [];
  const yesterdayData = history[url][yesterday] || [];
  const weekAgoData = history[url][weekAgo] || [];

  // Calculate daily change
  let dailyChange = 0;
  for (const kw of keywords) {
    const prev = yesterdayData.find(d => d.keyword === kw.keyword);
    if (prev) {
      dailyChange += (prev.position - kw.position); // positive = improved
    }
  }

  // Calculate weekly change
  let weeklyChange = 0;
  for (const kw of keywords) {
    const prev = weekAgoData.find(d => d.keyword === kw.keyword);
    if (prev) {
      weeklyChange += (prev.position - kw.position);
    }
  }

  // Enrich keywords with movement
  const enrichedKeywords = keywords.map(kw => {
    const yesterday = yesterdayData.find(d => d.keyword === kw.keyword);
    let dailyMovement = 0;
    if (yesterday) dailyMovement = yesterday.position - kw.position; // positive = improved

    const lastWeek = weekAgoData.find(d => d.keyword === kw.keyword);
    let weeklyMovement = 0;
    if (lastWeek) weeklyMovement = lastWeek.position - kw.position;

    return { ...kw, dailyMovement, weeklyMovement };
  });

  return { dailyChange, weeklyChange, keywords: enrichedKeywords };
}

// ─── States & Certs ────────────────────────────────────────────
const STATES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new-hampshire','new-jersey','new-mexico','new-york','north-carolina',
  'north-dakota','ohio','oklahoma','oregon','pennsylvania','rhode-island',
  'south-carolina','south-dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west-virginia','wisconsin','wyoming'
];
const CERTS = ['birth-certificate','death-certificate','marriage-certificate','divorce-certificate'];

// ─── Payload Auth ──────────────────────────────────────────────
async function getPayloadToken() {
  if (payloadToken && Date.now() < tokenExpiry) return payloadToken;
  try {
    const res = await fetch(`${PAYLOAD_URL}/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.PAYLOAD_EMAIL,
        password: process.env.PAYLOAD_PASSWORD
      })
    });
    const data = await res.json();
    payloadToken = data.token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min
    return payloadToken;
  } catch (e) {
    console.error('Payload auth failed:', e.message);
    return null;
  }
}

async function payloadFetch(endpoint, opts = {}) {
  const token = await getPayloadToken();
  if (!token) throw new Error('Not authenticated with Payload');
  const res = await fetch(`${PAYLOAD_URL}${endpoint}`, {
    ...opts,
    headers: { 'Authorization': `JWT ${token}`, 'Content-Type': 'application/json', ...opts.headers }
  });
  return res.json();
}

// ─── On-Page SEO Scoring Engine ────────────────────────────────
function scoreOnPageSEO(pageData, blockData, liveData) {
  const scores = {};
  const issues = [];
  const state = pageData.slug || '';
  const fullUrl = pageData.fullUrl || '';
  const useLive = liveData && liveData.success;

  // --- 1. Meta Title (15 pts) --- (prefer live data)
  const metaTitle = (useLive ? liveData.metaTitle : null) || pageData.meta?.title || pageData.title || '';
  if (!metaTitle) {
    scores.metaTitle = 0;  issues.push({ severity: 'critical', msg: 'Missing meta title' });
  } else if (metaTitle.length < 30) {
    scores.metaTitle = 5;  issues.push({ severity: 'warning', msg: `Meta title too short (${metaTitle.length} chars)` });
  } else if (metaTitle.length > 60) {
    scores.metaTitle = 8;  issues.push({ severity: 'warning', msg: `Meta title too long (${metaTitle.length} chars)` });
  } else {
    scores.metaTitle = 15;
  }

  // --- 2. Meta Description (10 pts) --- (prefer live data)
  const metaDesc = (useLive ? liveData.metaDesc : null) || pageData.meta?.description || '';
  if (!metaDesc) {
    scores.metaDesc = 0;  issues.push({ severity: 'critical', msg: 'Missing meta description' });
  } else if (metaDesc.length < 70) {
    scores.metaDesc = 3;  issues.push({ severity: 'warning', msg: `Meta description too short (${metaDesc.length} chars)` });
  } else if (metaDesc.length > 160) {
    scores.metaDesc = 5;  issues.push({ severity: 'warning', msg: `Meta description too long (${metaDesc.length} chars)` });
  } else {
    scores.metaDesc = 10;
  }

  // --- 3. H1 (10 pts) --- (use LIVE data when available)
  const h1s = useLive ? liveData.h1s : extractHeadings(blockData, 'h1');
  if (h1s.length === 0) {
    scores.h1 = 0;  issues.push({ severity: 'critical', msg: 'Missing H1 heading' });
  } else if (h1s.length > 1) {
    scores.h1 = 5;  issues.push({ severity: 'warning', msg: `Multiple H1s found (${h1s.length})` });
  } else {
    scores.h1 = 10;
  }

  // --- 4. H2 Quality (15 pts) --- (use LIVE data when available)
  const h2s = useLive ? liveData.h2s : extractHeadings(blockData, 'h2');
  let h2Score = 0;
  if (h2s.length === 0) {
    issues.push({ severity: 'critical', msg: 'No H2 headings found' });
  } else {
    h2Score = Math.min(5, h2s.length); // up to 5 pts for having H2s
    // Check if H2s contain state name
    const stateName = state.replace(/-/g, ' ');
    const certType = CERTS.find(c => fullUrl.includes(c))?.replace(/-/g, ' ') || '';
    let stateInH2 = 0;
    for (const h2 of h2s) {
      const lower = h2.toLowerCase();
      if (lower.includes(stateName)) stateInH2++;
    }
    const ratio = h2s.length > 0 ? stateInH2 / h2s.length : 0;
    h2Score += Math.round(ratio * 10); // up to 10 pts for state name in H2s
    if (ratio < 0.5) {
      issues.push({ severity: 'warning', msg: `Only ${stateInH2}/${h2s.length} H2s contain state name` });
    }
    // Check for plurals
    for (const h2 of h2s) {
      if (/\bCertificates\b/.test(h2)) {
        issues.push({ severity: 'warning', msg: `H2 uses plural "Certificates": "${h2}"` });
        h2Score = Math.max(0, h2Score - 2);
      }
    }
  }
  scores.h2Quality = Math.min(15, h2Score);

  // --- 5. Content Length (10 pts) --- (use LIVE word count when available)
  const contentText = useLive ? '' : extractAllText(blockData);
  const wordCount = useLive ? liveData.wordCount : contentText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 300) {
    scores.contentLength = 2;  issues.push({ severity: 'critical', msg: `Thin content (${wordCount} words)` });
  } else if (wordCount < 600) {
    scores.contentLength = 5;  issues.push({ severity: 'warning', msg: `Content could be longer (${wordCount} words)` });
  } else if (wordCount < 1000) {
    scores.contentLength = 8;
  } else {
    scores.contentLength = 10;
  }

  // --- 6. FAQ Section (20 pts) --- (use live FAQ count if higher)
  const faqDataPayload = extractFAQs(blockData);
  const faqData = useLive && liveData.faqCount > faqDataPayload.count
    ? { count: liveData.faqCount, questions: liveData.faqQuestions }
    : faqDataPayload;
  if (faqData.count === 0) {
    scores.faq = 0;  issues.push({ severity: 'critical', msg: 'No FAQ section found' });
  } else if (faqData.count < 5) {
    scores.faq = 5;  issues.push({ severity: 'warning', msg: `Only ${faqData.count} FAQs (target: 8-10)` });
  } else if (faqData.count < 8) {
    scores.faq = 10;  issues.push({ severity: 'info', msg: `${faqData.count} FAQs found (good, target: 8-10)` });
  } else {
    scores.faq = 20;
  }

  // --- 7. Internal Linking (10 pts) --- (use live link count when available)
  const links = useLive ? [] : extractLinks(blockData);
  const internalLinks = useLive ? Array(liveData.internalLinkCount || 0).fill('') : links.filter(l => l.includes('vitalrecordsonline.com') || l.startsWith('/'));
  if (internalLinks.length === 0) {
    scores.internalLinks = 0;  issues.push({ severity: 'warning', msg: 'No internal links found' });
  } else if (internalLinks.length < 3) {
    scores.internalLinks = 5;
  } else {
    scores.internalLinks = 10;
  }

  // --- 8. Image Optimization (5 pts) --- (use live images when available)
  const images = useLive ? (liveData.images || []) : extractImages(blockData);
  let imgScore = images.length > 0 ? 3 : 0;
  if (images.length === 0) issues.push({ severity: 'info', msg: 'No images found in content blocks' });
  // Check for alt text presence
  const withAlt = images.filter(i => i.alt && i.alt.trim());
  if (images.length > 0 && withAlt.length === images.length) imgScore = 5;
  else if (images.length > 0 && withAlt.length < images.length) {
    issues.push({ severity: 'warning', msg: `${images.length - withAlt.length} images missing alt text` });
  }
  scores.imageOpt = imgScore;

  // --- 9. Structured Data Readiness (5 pts) ---
  // Check if FAQ schema could be generated
  scores.schemaReady = faqData.count >= 3 ? 5 : (faqData.count > 0 ? 2 : 0);
  if (faqData.count < 3) issues.push({ severity: 'info', msg: 'Not enough FAQs for rich snippet schema' });

  // --- Total ---
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const maxScore = 100;
  const grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'F';

  // ─── Recommendations to reach A (85+) ───
  const recommendations = [];
  const pointsNeeded = Math.max(0, 85 - total);
  const maxes = { metaTitle: 15, metaDesc: 10, h1: 10, h2Quality: 15, contentLength: 10, faq: 20, internalLinks: 10, imageOpt: 5, schemaReady: 5 };
  const stateName = (fullUrl.split('/')[1] || '').replace(/-/g, ' ');
  const certType = CERTS.find(c => fullUrl.includes(c))?.replace(/-/g, ' ') || 'certificate';
  const certTypeCapitalized = certType.replace(/\b\w/g, c => c.toUpperCase());

  // Sort by biggest gap (most points recoverable first)
  const gaps = Object.entries(scores).map(([k, v]) => ({ key: k, score: v, max: maxes[k], gap: maxes[k] - v })).filter(g => g.gap > 0).sort((a, b) => b.gap - a.gap);

  for (const g of gaps) {
    switch (g.key) {
      case 'metaTitle':
        if (scores.metaTitle === 0) {
          recommendations.push({ priority: 'critical', points: g.gap, category: 'Meta Title', action: `Add a meta title. Target 50-60 chars with primary keyword: "${stateName} ${certTypeCapitalized} - Order Online | VRO"`, current: 'Missing' });
        } else if (metaTitle.length < 30) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'Meta Title', action: `Expand meta title from ${metaTitle.length} to 50-60 chars. Include "${stateName}" and "${certType}" keywords.`, current: `${metaTitle.length} chars (too short)` });
        } else if (metaTitle.length > 60) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'Meta Title', action: `Shorten meta title from ${metaTitle.length} to under 60 chars to prevent truncation in search results.`, current: `${metaTitle.length} chars (too long)` });
        }
        break;

      case 'metaDesc':
        if (scores.metaDesc === 0) {
          recommendations.push({ priority: 'critical', points: g.gap, category: 'Meta Description', action: `Add a meta description (120-155 chars). Include: "${stateName} ${certType}", processing time, and a call-to-action like "Order online today."`, current: 'Missing' });
        } else if (metaDesc.length < 70) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'Meta Description', action: `Expand meta description from ${metaDesc.length} to 120-155 chars. Add fees, processing time, or eligibility details to increase click-through rate.`, current: `${metaDesc.length} chars (too short)` });
        } else if (metaDesc.length > 160) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'Meta Description', action: `Trim meta description from ${metaDesc.length} to under 160 chars. Google truncates longer descriptions.`, current: `${metaDesc.length} chars (too long)` });
        }
        break;

      case 'h1':
        if (h1s.length === 0) {
          recommendations.push({ priority: 'critical', points: g.gap, category: 'H1 Heading', action: `Add an H1 heading with the primary keyword, e.g. "Get Your Certified ${stateName.split(' ').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')} ${certTypeCapitalized}"`, current: 'Missing' });
        } else if (h1s.length > 1) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'H1 Heading', action: `Reduce to a single H1. Currently ${h1s.length} H1s found. Keep the most relevant one and change others to H2.`, current: `${h1s.length} H1s (should be 1)` });
        }
        break;

      case 'h2Quality': {
        const stateInH2 = h2s.filter(h => h.toLowerCase().includes(stateName)).length;
        const pluralH2s = h2s.filter(h => /\bCertificates\b/.test(h));
        const missingState = h2s.length - stateInH2;
        const recs = [];
        if (missingState > 0) {
          recs.push(`Add "${stateName}" to ${missingState} H2s that are missing it. Example: change "Fees" → "${stateName.split(' ').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')} ${certTypeCapitalized} Fees"`);
        }
        if (pluralH2s.length > 0) {
          recs.push(`Fix ${pluralH2s.length} H2(s) using plural "Certificates" → change to singular "Certificate"`);
        }
        if (h2s.length < 5) {
          recs.push(`Add more H2 sections. Currently ${h2s.length} H2s — aim for 6-10 covering fees, processing time, eligibility, how to order, required documents, etc.`);
        }
        if (recs.length > 0) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'H2 Headings', action: recs.join(' | '), current: `${h2s.length} H2s, ${stateInH2} with state name` });
        }
        break;
      }

      case 'contentLength':
        if (wordCount < 300) {
          recommendations.push({ priority: 'critical', points: g.gap, category: 'Content Length', action: `Page has only ${wordCount} words — this is thin content. Add detailed sections: eligibility requirements, step-by-step ordering process, required documents, fees breakdown, and processing times. Target 800+ words.`, current: `${wordCount} words (thin)` });
        } else if (wordCount < 600) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'Content Length', action: `Expand content from ${wordCount} to 800+ words. Add sections on: who can order, what documents are needed, expedited options, and common mistakes to avoid.`, current: `${wordCount} words` });
        } else if (wordCount < 1000) {
          recommendations.push({ priority: 'low', points: g.gap, category: 'Content Length', action: `Content is decent at ${wordCount} words. To max this score, expand to 1000+ words with additional detail on eligibility exceptions, county-specific info, or related certificates.`, current: `${wordCount} words` });
        }
        break;

      case 'faq':
        if (faqData.count === 0) {
          recommendations.push({ priority: 'critical', points: g.gap, category: 'FAQ Section', action: `Add an FAQ section with 8-10 questions. Key topics: "How to order a ${stateName} ${certType}?", "How much does a ${stateName} ${certType} cost?", "How long does it take?", "Who can order?", "What documents do I need?". Each answer should be 2-3 paragraphs with state-specific details.`, current: 'No FAQs' });
        } else if (faqData.count < 5) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'FAQ Section', action: `Add ${8 - faqData.count} more FAQs (currently ${faqData.count}, target 8-10). Focus on long-tail queries: expedited processing, apostille requirements, name change on certificates, ordering for deceased relatives, rejected application fixes.`, current: `${faqData.count} FAQs` });
        } else if (faqData.count < 8) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'FAQ Section', action: `Add ${8 - faqData.count} more FAQs to reach the target of 8-10. Consider: "Can I get a ${stateName} ${certType} online?", "What if my name has changed?", "How do I get an apostille?", "Can a third party order on my behalf?"`, current: `${faqData.count} FAQs` });
        }
        break;

      case 'internalLinks':
        if (internalLinks.length === 0) {
          recommendations.push({ priority: 'high', points: g.gap, category: 'Internal Links', action: `Add 3-5 internal links to related pages: other ${stateName} certificates (birth, death, marriage, divorce), the "How It Works" page, and the main services page. This helps both users and search engines navigate your site.`, current: 'No internal links' });
        } else if (internalLinks.length < 3) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'Internal Links', action: `Add ${3 - internalLinks.length} more internal links. Link to other ${stateName} certificate pages and to the ordering process page.`, current: `${internalLinks.length} internal link(s)` });
        }
        break;

      case 'imageOpt':
        if (images.length === 0) {
          recommendations.push({ priority: 'medium', points: g.gap, category: 'Images', action: `Add at least one relevant image (state map, certificate sample, or process infographic) with descriptive alt text containing "${stateName} ${certType}".`, current: 'No images' });
        } else {
          const missingAlt = images.filter(i => !i.alt || !i.alt.trim()).length;
          if (missingAlt > 0) {
            recommendations.push({ priority: 'medium', points: g.gap, category: 'Images', action: `Add alt text to ${missingAlt} image(s). Use descriptive text like "${stateName.split(' ').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ')} ${certTypeCapitalized} Application Form" — helps SEO and accessibility.`, current: `${missingAlt} missing alt text` });
          }
        }
        break;

      case 'schemaReady':
        if (faqData.count < 3) {
          recommendations.push({ priority: 'low', points: g.gap, category: 'Schema / Rich Snippets', action: `Need at least 3 FAQs to generate FAQ rich snippets in Google search results. Add FAQs first (see FAQ recommendation above).`, current: `${faqData.count} FAQs (need 3+)` });
        }
        break;
    }
  }

  // Sort recommendations: critical first, then by points recoverable
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || b.points - a.points);

  return {
    scores,
    total,
    maxScore,
    grade,
    issues,
    recommendations,
    pointsToA: pointsNeeded,
    meta: { metaTitle, metaDesc, h1s, h2s, wordCount, faqCount: faqData.count, faqQuestions: faqData.questions, internalLinkCount: internalLinks.length, imageCount: images.length, source: useLive ? 'live' : 'payload' }
  };
}

// ─── Block Traversal Helpers ───────────────────────────────────
function traverseBlocks(block, visitor, depth = 0) {
  if (!block || typeof block !== 'object') return;
  visitor(block, depth);
  if (Array.isArray(block.content)) block.content.forEach(b => traverseBlocks(b, visitor, depth + 1));
  if (Array.isArray(block.contents)) {
    block.contents.forEach(b => {
      if (typeof b === 'object') traverseBlocks(b, visitor, depth + 1);
    });
  }
  if (Array.isArray(block.columns)) {
    block.columns.forEach(col => {
      if (col.contents) col.contents.forEach(b => {
        if (typeof b === 'object') traverseBlocks(b, visitor, depth + 1);
      });
    });
  }
}

function extractRichTextNodes(richText, type, tag) {
  const results = [];
  if (!richText?.root?.children) return results;
  function walk(nodes) {
    for (const n of nodes) {
      if (n.type === type && (!tag || n.tag === tag)) {
        const text = (n.children || []).map(c => c.text || '').join('');
        if (text) results.push(text);
      }
      if (n.children) walk(n.children);
    }
  }
  walk(richText.root.children);
  return results;
}

function extractHeadings(blocks, tag) {
  const headings = [];
  for (const block of blocks) {
    traverseBlocks(block, (b) => {
      if (b.richText) headings.push(...extractRichTextNodes(b.richText, 'heading', tag));
    });
  }
  return headings;
}

function extractAllText(blocks) {
  const texts = [];
  for (const block of blocks) {
    traverseBlocks(block, (b) => {
      if (b.richText?.root?.children) {
        function walk(nodes) {
          for (const n of nodes) {
            if (n.text) texts.push(n.text);
            if (n.children) walk(n.children);
          }
        }
        walk(b.richText.root.children);
      }
    });
  }
  return texts.join(' ');
}

function extractFAQs(blocks) {
  const questions = [];
  for (const block of blocks) {
    traverseBlocks(block, (b) => {
      // Match both 'faq' and 'accordion' block types
      if ((b.blockType === 'faq' || b.blockType === 'accordion') && Array.isArray(b.columns)) {
        for (const col of b.columns) {
          if (col.title) questions.push(col.title);
        }
      }
    });
  }
  return { count: questions.length, questions };
}

function extractLinks(blocks) {
  const links = [];
  for (const block of blocks) {
    traverseBlocks(block, (b) => {
      if (b.richText?.root?.children) {
        function walk(nodes) {
          for (const n of nodes) {
            if (n.type === 'link' && n.fields?.url) links.push(n.fields.url);
            if (n.type === 'autolink' && n.url) links.push(n.url);
            if (n.children) walk(n.children);
          }
        }
        walk(b.richText.root.children);
      }
      // CTA buttons
      if (b.blockType === 'cta' && b.url) links.push(b.url);
    });
  }
  return links;
}

function extractImages(blocks) {
  const images = [];
  for (const block of blocks) {
    traverseBlocks(block, (b) => {
      // 'image' blocks with .image field
      if (b.blockType === 'image' && b.image) {
        images.push({ url: b.image.url || '', alt: b.image.alt || '' });
      }
      // 'mediaBlock' blocks with .media field (VRO's actual block type)
      if (b.blockType === 'mediaBlock' && b.media) {
        const m = typeof b.media === 'object' ? b.media : null;
        if (m) images.push({ url: m.url || '', alt: m.alt || '' });
      }
    });
  }
  return images;
}

// ─── Live Page Scraping ───────────────────────────────────────
function extractTagContent(html, tag) {
  const results = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = regex.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    if (text) results.push(text);
  }
  return results;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…');
}

// Convert a chunk of HTML into a readable Markdown string. Used for section content
// so that <ul>/<li>, <p>, <h3>, <strong>, <a> survive the strip step instead of
// collapsing into a single paragraph.
function htmlToMarkdown(html) {
  let s = html;
  // Strip noise that may have been left inside the section
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  // Inline emphasis
  s = s.replace(/<\/?(?:strong|b)\b[^>]*>/gi, '**');
  s = s.replace(/<\/?(?:em|i)\b[^>]*>/gi, '*');
  // Anchors → [text](url)
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const t = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return t ? `[${t}](${url})` : url;
  });
  // Sub-headings within a section
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  s = s.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  s = s.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n');
  // Lists — emit one bullet per <li>; preserve numbering within <ol>
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return '\n' + inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, li) => `\n${++n}. ${li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`) + '\n';
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    return '\n' + inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, li) => `\n- ${li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`) + '\n';
  });
  // Any leftover <li> outside a recognized list
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, li) => `\n- ${li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
  // Block boundaries
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n').replace(/<div\b[^>]*>/gi, '');
  // Drop everything else
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Whitespace cleanup — keep newlines, collapse spaces/tabs
  s = s.replace(/[ \t]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return s;
}

async function scrapeLivePage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VRO-SEO-Analyzer/1.0 (+https://vitalrecordsonline.com)' },
      timeout: 15000
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const html = await res.text();

    // Meta title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    // Meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
      || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
    const metaDesc = descMatch ? descMatch[1].trim() : '';

    // Headings
    const h1s = extractTagContent(html, 'h1');
    const h2s = extractTagContent(html, 'h2');
    const h3s = extractTagContent(html, 'h3');

    // Body text (from <main> or full body, strip scripts/styles)
    let bodyHtml = html;
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) bodyHtml = mainMatch[1];
    bodyHtml = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '');
    const bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

    // VRO service fee — try multiple patterns the marketing page uses
    let vroFee = null;
    let vroFeeContext = null;
    // 1) "Starting from $XX" hero block
    const startingFromMatch = bodyHtml.match(/Starting\s+from[\s\S]{0,200}?\$([0-9]+(?:\.[0-9]{2})?)([^<]{0,80}?)</i);
    if (startingFromMatch) {
      vroFee = `$${startingFromMatch[1]}`;
      const tail = (startingFromMatch[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      vroFeeContext = `Starting from ${vroFee}${tail ? ' ' + tail : ' + state fees'}`.trim();
    }
    // 2) "VRO's $XX filing fee" strong line
    if (!vroFee) {
      const filingMatch = bodyHtml.match(/VRO['’']?s?\s*\$([0-9]+(?:\.[0-9]{2})?)\s*filing\s*fee/i);
      if (filingMatch) {
        vroFee = `$${filingMatch[1]}`;
        vroFeeContext = `VRO's ${vroFee} filing fee`;
      }
    }
    // 3) Fallback HTML-entity-encoded variant ("VRO&#x27;s $29 filing fee")
    if (!vroFee) {
      const filingEntMatch = bodyHtml.match(/VRO(?:&#x27;|&#39;|&apos;)s?\s*\$([0-9]+(?:\.[0-9]{2})?)\s*filing\s*fee/i);
      if (filingEntMatch) {
        vroFee = `$${filingEntMatch[1]}`;
        vroFeeContext = `VRO's ${vroFee} filing fee`;
      }
    }

    // Links — capture both href and anchor text from body (excluding nav/footer)
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const linkPairsAll = [];
    let am0;
    while ((am0 = anchorRegex.exec(bodyHtml)) !== null) {
      const url = am0[1].trim();
      const text = am0[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!url || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) continue;
      linkPairsAll.push({ url, text });
    }
    // Dedupe by url+text
    const seenLinks = new Set();
    const linkPairs = linkPairsAll.filter(l => {
      const key = `${l.url}|${l.text}`;
      if (seenLinks.has(key)) return false;
      seenLinks.add(key);
      return true;
    });
    const internalLinkPairs = linkPairs.filter(l => l.url.includes('vitalrecordsonline.com') || (l.url.startsWith('/') && !l.url.startsWith('//')));
    const externalLinkPairs = linkPairs.filter(l => l.url.startsWith('http') && !l.url.includes('vitalrecordsonline.com'));
    const internalLinks = internalLinkPairs.map(l => l.url);
    const externalLinks = externalLinkPairs.map(l => l.url);

    // Images
    const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
    const images = [];
    let im;
    while ((im = imgRegex.exec(html)) !== null) images.push({ url: im[1], alt: im[2] || '' });

    // FAQ questions — extract from accordion buttons, summary tags, or FAQ schema
    const faqQuestions = [];
    // From LD+JSON schema
    const schemaRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = schemaRegex.exec(html)) !== null) {
      try {
        const schema = JSON.parse(sm[1]);
        if (schema['@type'] === 'FAQPage' && Array.isArray(schema.mainEntity)) {
          schema.mainEntity.forEach(q => { if (q.name) faqQuestions.push(q.name); });
        }
      } catch(e) {}
    }
    // From accordion titles (VRO's pattern: column titles in FAQ blocks)
    const accordionRegex = /<(?:button|summary|h3|h4)[^>]*class=["'][^"']*(?:accordion|faq)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|summary|h3|h4)>/gi;
    let am;
    while ((am = accordionRegex.exec(html)) !== null) {
      const text = am[1].replace(/<[^>]+>/g, '').trim();
      if (text && text.includes('?') && !faqQuestions.includes(text)) faqQuestions.push(text);
    }

    // Extract sections (H2 + content until next H2) — preserve list/heading/link structure as markdown
    const sections = [];
    const h2Positions = [];
    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let h2m;
    while ((h2m = h2Regex.exec(bodyHtml)) !== null) {
      h2Positions.push({ title: h2m[1].replace(/<[^>]+>/g, '').trim(), index: h2m.index, endIndex: h2m.index + h2m[0].length });
    }
    for (let i = 0; i < h2Positions.length; i++) {
      const start = h2Positions[i].endIndex;
      const end = i + 1 < h2Positions.length ? h2Positions[i + 1].index : bodyHtml.length;
      const sectionHtml = bodyHtml.substring(start, end);
      sections.push({ title: h2Positions[i].title, content: htmlToMarkdown(sectionHtml) });
    }

    return {
      success: true,
      metaTitle,
      metaDesc,
      h1s, h2s, h3s,
      wordCount,
      internalLinkCount: internalLinks.length,
      externalLinkCount: externalLinks.length,
      internalLinkPairs,
      externalLinkPairs,
      images,
      faqQuestions,
      faqCount: faqQuestions.length,
      sections,
      vroFee,
      vroFeeContext,
      fullText: bodyText.substring(0, 10000)
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ─── Markdown Generation ──────────────────────────────────────
const CATEGORY_DEFS = [
  { slug: 'faqs',            file: '06-faqs.md',            label: 'FAQs',            test: t => /\bfaqs?\b|frequent|questions?\b/i.test(t) },
  { slug: 'notary',           file: '03-notary.md',           label: 'Notary',           test: t => /\bnotar(y|i[zs]ation)?\b|\bsignature\b|\bsigned\b/i.test(t) },
  { slug: 'id-requirements',  file: '01-id-requirements.md',  label: 'ID Requirements',  test: t => /\b(id|identification|identity)\b|\b(documents?\s+(required|needed))|valid\s+id|government[\s-]?issued/i.test(t) },
  { slug: 'relationship',     file: '02-relationship.md',     label: 'Relationship & Eligibility', test: t => /\b(who\s+can|eligibility|eligible|relationship|qualify|qualifies|authorized|requestor|applicant|tier|immediate\s+family)\b/i.test(t) },
  { slug: 'fees',             file: '04-fees.md',             label: 'Fees',             test: t => /\b(fee|fees|cost|costs|price|pricing|charge|payment)\b|\$/i.test(t) },
  { slug: 'processing-time',  file: '05-processing-time.md',  label: 'Processing Time',  test: t => /\b(processing|process\s+time|turnaround|delivery|deliver|shipping|ship|expedite|expedited|how\s+long|wait\s+time|business\s+days?)\b/i.test(t) },
];

function classifySection(title) {
  for (const cat of CATEGORY_DEFS) if (cat.test(title || '')) return cat.slug;
  return 'overview';
}

function titleCase(s) {
  return s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function generateOverviewMarkdown(stateName, certName, url, liveData, payloadMeta, overviewSections) {
  let md = `# ${stateName} ${certName} — Overview\n\n`;
  md += `**URL:** ${url}\n`;
  md += `**Meta Title:** ${liveData.metaTitle || payloadMeta?.title || 'N/A'}\n`;
  md += `**Meta Description:** ${liveData.metaDesc || payloadMeta?.description || 'N/A'}\n`;
  md += `**Word Count:** ${liveData.wordCount || 0}\n`;
  md += `**H1:** ${(liveData.h1s || [])[0] || 'N/A'}\n`;
  md += `**FAQ Count:** ${liveData.faqCount || 0}\n`;
  md += `**Internal Links:** ${liveData.internalLinkCount || 0}\n`;
  md += `**External Links:** ${liveData.externalLinkCount || 0}\n`;
  md += `**Images:** ${(liveData.images || []).length}\n\n`;
  md += `---\n\n`;
  if (overviewSections.length > 0) {
    for (const s of overviewSections) {
      md += `## ${s.title}\n\n${s.content}\n\n`;
    }
  } else {
    md += `_No overview sections were classified to this category. See sibling files for ID requirements, fees, processing time, etc._\n\n`;
  }
  return md;
}

function generateSectionsMarkdown(stateName, certName, label, sections) {
  let md = `# ${stateName} ${certName} — ${label}\n\n`;
  if (sections.length === 0) {
    md += `_No sections matched this category for this page._\n`;
    return md;
  }
  for (const s of sections) {
    md += `## ${s.title}\n\n${s.content}\n\n`;
  }
  return md;
}

function generateFaqMarkdown(stateName, certName, faqQuestions, faqSections) {
  let md = `# ${stateName} ${certName} — FAQs\n\n`;
  const all = [];
  faqQuestions.forEach(q => all.push({ question: q, answer: '' }));
  // Append any FAQ-classified H2 sections as additional Q&A blocks if not already covered
  for (const s of faqSections) {
    if (!all.find(a => a.question.toLowerCase() === (s.title || '').toLowerCase())) {
      all.push({ question: s.title, answer: s.content });
    }
  }
  if (all.length === 0) {
    md += `_No FAQs detected on this page._\n`;
    return md;
  }
  all.forEach((f, i) => {
    md += `### ${i + 1}. ${f.question}\n\n`;
    if (f.answer) md += `${f.answer}\n\n`;
  });
  return md;
}

function generateLinksMarkdown(stateName, certName, internalPairs, externalPairs) {
  let md = `# ${stateName} ${certName} — Links\n\n`;
  md += `## Internal Links (${internalPairs.length})\n\n`;
  if (internalPairs.length === 0) {
    md += `_None_\n\n`;
  } else {
    for (const l of internalPairs) {
      const desc = l.text || '(no anchor text)';
      md += `- [${desc}](${l.url})\n`;
    }
    md += `\n`;
  }
  md += `## External Links (${externalPairs.length})\n\n`;
  if (externalPairs.length === 0) {
    md += `_None_\n\n`;
  } else {
    for (const l of externalPairs) {
      const desc = l.text || '(no anchor text)';
      md += `- [${desc}](${l.url})\n`;
    }
    md += `\n`;
  }
  return md;
}

function generateServicesCostsMarkdown(stateName, certName, liveData) {
  const scrapedFee = liveData && liveData.vroFee;
  const scrapedContext = liveData && liveData.vroFeeContext;
  const envFee = (process.env.VRO_SERVICE_FEE || '').trim();
  let feeLine;
  if (scrapedFee) {
    feeLine = `**VRO service fee:** ${scrapedFee}${scrapedContext ? ` (${scrapedContext})` : ''} — charged once per order, separate from the state/government fee.`;
  } else if (envFee) {
    feeLine = `**VRO service fee:** ${envFee} — charged once per order, separate from any government fee.`;
  } else {
    feeLine = `**VRO service fee:** see vitalrecordsonline.com for current pricing — varies by service tier and add-ons.`;
  }

  return `# ${stateName} ${certName} — VRO Services & Costs\n\n` +
`## What Vital Records Online (VRO) Does\n\n` +
`Vital Records Online is an independent ordering-assistance service that helps people request certified copies of vital records (birth, death, marriage, and divorce certificates) from the issuing state or county vital records office. VRO is **not** a government agency and is not affiliated with any state or federal vital records office.\n\n` +
`Our service handles the parts of the process that most people find frustrating: figuring out which agency to apply to, completing the correct application, gathering the right supporting documents, formatting the request to that agency's specifications, reviewing for errors before submission, and tracking the order through fulfillment.\n\n` +
`## What's Included\n\n` +
`- Application form completion and review\n` +
`- Document checklist and ID-requirement guidance specific to ${stateName}\n` +
`- Pre-submission error check (a leading cause of rejections)\n` +
`- Order tracking and customer support before, during, and after submission\n` +
`- Secure handling of personal information (PII)\n\n` +
`## VRO Service Fee\n\n` +
`${feeLine}\n\n` +
`This fee covers application preparation, review, and support — it does **not** include the official cost of the certificate itself, which is paid directly to the issuing agency.\n\n` +
`Government fees vary by state and certificate type. Expedited shipping, additional copies, and apostille services are available at additional cost where supported.\n\n` +
`## What VRO Does Not Do\n\n` +
`- Issue certificates directly (only the state/county vital records office can do that)\n` +
`- Guarantee approval of any individual application (that decision is made by the issuing agency)\n` +
`- Provide legal advice on the use of vital records\n\n` +
`## Why Customers Choose VRO\n\n` +
`- One streamlined online form instead of navigating multiple government websites\n` +
`- Plain-language guidance on eligibility, ID, and notarization rules\n` +
`- Live customer support throughout the process\n` +
`- Secure, encrypted handling of sensitive identification documents\n\n` +
`---\n_This file is a static overview of VRO services and is included with every state/certificate export. For state-specific fees, eligibility, and processing time, see the sibling files in this folder._\n`;
}

function generateCategoryMarkdownFiles(state, cert, liveData, payloadMeta) {
  const stateName = titleCase(state);
  const certName = titleCase(cert);
  const url = `https://www.vitalrecordsonline.com/${state}/${cert}`;

  // Bucket sections by category
  const buckets = { overview: [], 'id-requirements': [], relationship: [], notary: [], fees: [], 'processing-time': [], faqs: [] };
  for (const s of (liveData.sections || [])) {
    const cat = classifySection(s.title);
    (buckets[cat] || (buckets[cat] = [])).push(s);
  }

  const files = {};
  files['00-overview.md']         = generateOverviewMarkdown(stateName, certName, url, liveData, payloadMeta, buckets.overview);
  files['01-id-requirements.md']  = generateSectionsMarkdown(stateName, certName, 'ID Requirements',     buckets['id-requirements']);
  files['02-relationship.md']     = generateSectionsMarkdown(stateName, certName, 'Relationship & Eligibility', buckets.relationship);
  files['03-notary.md']           = generateSectionsMarkdown(stateName, certName, 'Notary',              buckets.notary);
  files['04-fees.md']             = generateSectionsMarkdown(stateName, certName, 'Fees',                buckets.fees);
  files['05-processing-time.md']  = generateSectionsMarkdown(stateName, certName, 'Processing Time',     buckets['processing-time']);
  files['06-faqs.md']             = generateFaqMarkdown(stateName, certName, liveData.faqQuestions || [], buckets.faqs);
  files['07-links.md']            = generateLinksMarkdown(stateName, certName, liveData.internalLinkPairs || [], liveData.externalLinkPairs || []);
  files['08-services-costs.md']   = generateServicesCostsMarkdown(stateName, certName, liveData);

  // Append generated-at footer
  const footer = `\n---\n*Generated: ${new Date().toISOString().split('T')[0]} by VRO SEO Analyzer*\n`;
  for (const k of Object.keys(files)) files[k] += footer;
  return files;
}

// Backward-compatible single-file MD (used by single-page download as a flat fallback)
function generatePageMarkdown(state, cert, liveData, payloadMeta) {
  const files = generateCategoryMarkdownFiles(state, cert, liveData, payloadMeta);
  return Object.entries(files).map(([name, content]) => `<!-- FILE: ${name} -->\n${content}`).join('\n\n');
}

// ─── DeepSeek AI Analysis ─────────────────────────────────────
async function runDeepSeekAnalysis(pageData) {
  const apiKey = getSetting('deepseek_api_key', DEEPSEEK_KEY);
  if (!apiKey) return { available: false, error: 'No DeepSeek API key configured' };

  const { state, cert, liveData, onPage } = pageData;
  const stateName = state.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const certName = cert.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const prompt = `You are an SEO expert specializing in vital records and government document services. Analyze this page and provide specific, actionable recommendations.

Page: ${stateName} ${certName}
URL: https://www.vitalrecordsonline.com/${state}/${cert}
Meta Title: ${liveData.metaTitle || 'N/A'}
Meta Description: ${liveData.metaDesc || 'N/A'}
Word Count: ${liveData.wordCount || 0}
H2 Headings: ${(liveData.h2s || []).join(' | ')}
FAQ Questions (${(liveData.faqQuestions || []).length}): ${(liveData.faqQuestions || []).join(' | ')}
Internal Links: ${liveData.internalLinkCount || 0}
Current SEO Score: ${onPage?.total || 0}/100 (Grade: ${onPage?.grade || 'N/A'})

Key issues found:
${(onPage?.issues || []).map(i => `- [${i.severity}] ${i.msg}`).join('\n')}

Provide your analysis in this JSON format:
{
  "overallAssessment": "2-3 sentence summary",
  "contentGaps": ["list of missing content topics for this specific state/cert"],
  "h2Suggestions": ["5 optimized H2 suggestions with state name"],
  "metaTitleSuggestion": "improved meta title under 60 chars",
  "metaDescSuggestion": "improved meta description 120-155 chars",
  "faqSuggestions": ["3-5 new FAQ questions targeting long-tail keywords"],
  "quickWins": ["3 easy fixes that would improve score fastest"],
  "competitorKeywords": ["5 keywords competitors likely rank for that this page should target"]
}`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    if (data.error) return { available: false, error: data.error.message || JSON.stringify(data.error) };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { available: false, error: 'Empty response from DeepSeek' };
    try {
      return { available: true, analysis: JSON.parse(content), model: data.model, usage: data.usage };
    } catch(e) {
      return { available: true, analysis: { overallAssessment: content }, rawText: true };
    }
  } catch(e) {
    return { available: false, error: e.message };
  }
}

// ─── Ahrefs API ────────────────────────────────────────────────
async function fetchAhrefsData(url) {
  if (!AHREFS_TOKEN) return { available: false, error: 'No Ahrefs API token configured' };
  try {
    // Domain metrics
    const metricsRes = await fetch(
      `https://api.ahrefs.com/v3/site-explorer/overview?target=${encodeURIComponent('vitalrecordsonline.com')}&mode=subdomains&output=json`,
      { headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}` } }
    );
    const metrics = await metricsRes.json();

    // Organic keywords for specific URL
    const kwRes = await fetch(
      `https://api.ahrefs.com/v3/site-explorer/organic-keywords?target=${encodeURIComponent(url)}&mode=exact&country=us&limit=20&output=json`,
      { headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}` } }
    );
    const kwData = await kwRes.json();

    // Backlinks for URL
    const blRes = await fetch(
      `https://api.ahrefs.com/v3/site-explorer/backlinks-stats?target=${encodeURIComponent(url)}&mode=exact&output=json`,
      { headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}` } }
    );
    const blData = await blRes.json();

    // Parse organic keywords into standardized format for SERP tracking
    const rawKeywords = kwData.keywords || [];
    const keywords = rawKeywords.map(k => ({
      keyword: k.keyword || '',
      position: k.position || 0,
      volume: k.volume || 0,
      traffic: k.traffic || 0
    })).filter(k => k.keyword);

    return {
      available: true,
      domainRating: metrics.metrics?.domain_rating || null,
      organicKeywords: rawKeywords,
      keywords, // standardized keyword list for SERP tracking
      keywordCount: keywords.length,
      totalTraffic: keywords.reduce((sum, k) => sum + (k.traffic || 0), 0),
      organicTraffic: kwData.metrics?.organic_traffic || keywords.reduce((sum, k) => sum + (k.traffic || 0), 0),
      backlinks: blData.metrics?.live || 0,
      referringDomains: blData.metrics?.live_refdomains || 0
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// ─── SEMrush API ───────────────────────────────────────────────
async function fetchSemrushData(url) {
  if (!SEMRUSH_KEY) return { available: false, error: 'No SEMrush API key configured' };
  try {
    const domain = 'vitalrecordsonline.com';
    const urlPath = url.replace('https://www.vitalrecordsonline.com', '');

    // Domain organic overview
    const overviewRes = await fetch(
      `https://api.semrush.com/?type=domain_organic&key=${SEMRUSH_KEY}&display_limit=5&export_columns=Ph,Po,Nq,Cp,Ur,Tr&domain=${domain}&database=us&display_filter=%2B|Ur|Co|${encodeURIComponent(urlPath)}`
    );
    const overviewText = await overviewRes.text();
    const rows = overviewText.trim().split('\n').slice(1); // skip header
    const keywords = rows.map(row => {
      const [keyword, position, volume, cpc, url, traffic] = row.split(';');
      return { keyword, position: parseInt(position), volume: parseInt(volume), cpc: parseFloat(cpc), traffic: parseFloat(traffic) };
    }).filter(k => k.keyword);

    // URL organic keywords count
    const urlRes = await fetch(
      `https://api.semrush.com/?type=url_organic&key=${SEMRUSH_KEY}&display_limit=20&export_columns=Ph,Po,Nq,Tr&url=${encodeURIComponent(url)}&database=us`
    );
    const urlText = await urlRes.text();
    const urlRows = urlText.trim().split('\n').slice(1);
    const urlKeywords = urlRows.map(row => {
      const [keyword, position, volume, traffic] = row.split(';');
      return { keyword, position: parseInt(position), volume: parseInt(volume), traffic: parseFloat(traffic) };
    }).filter(k => k.keyword);

    return {
      available: true,
      keywords: urlKeywords,
      keywordCount: urlKeywords.length,
      totalTraffic: urlKeywords.reduce((sum, k) => sum + (k.traffic || 0), 0),
      topPositions: urlKeywords.filter(k => k.position <= 10).length,
      avgPosition: urlKeywords.length > 0 ? Math.round(urlKeywords.reduce((sum, k) => sum + k.position, 0) / urlKeywords.length) : null
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// ─── Combined Score ────────────────────────────────────────────
function computeFinalRating(onPageScore, ahrefsData, semrushData) {
  let totalScore = onPageScore.total; // out of 100
  let maxPossible = 100;
  const boosts = [];

  // Ahrefs boosts (up to +30)
  if (ahrefsData.available) {
    maxPossible += 30;
    let ahrefsScore = 0;
    if (ahrefsData.backlinks > 0) { ahrefsScore += 5; boosts.push(`+5 backlinks (${ahrefsData.backlinks})`); }
    if (ahrefsData.referringDomains > 0) { ahrefsScore += 5; boosts.push(`+5 ref domains (${ahrefsData.referringDomains})`); }
    if (ahrefsData.organicKeywords?.length > 5) { ahrefsScore += 10; boosts.push(`+10 organic KWs (${ahrefsData.organicKeywords.length})`); }
    else if (ahrefsData.organicKeywords?.length > 0) { ahrefsScore += 5; boosts.push(`+5 some organic KWs`); }
    if (ahrefsData.organicTraffic > 100) { ahrefsScore += 10; boosts.push(`+10 traffic (${ahrefsData.organicTraffic})`); }
    else if (ahrefsData.organicTraffic > 20) { ahrefsScore += 5; boosts.push(`+5 some traffic`); }
    totalScore += ahrefsScore;
  }

  // SEMrush boosts (up to +30)
  if (semrushData.available) {
    maxPossible += 30;
    let semScore = 0;
    if (semrushData.topPositions > 3) { semScore += 10; boosts.push(`+10 top-10 KWs (${semrushData.topPositions})`); }
    else if (semrushData.topPositions > 0) { semScore += 5; boosts.push(`+5 some top-10 KWs`); }
    if (semrushData.keywordCount > 20) { semScore += 10; boosts.push(`+10 total KWs (${semrushData.keywordCount})`); }
    else if (semrushData.keywordCount > 5) { semScore += 5; boosts.push(`+5 some KWs`); }
    if (semrushData.avgPosition && semrushData.avgPosition < 20) { semScore += 10; boosts.push(`+10 avg pos (${semrushData.avgPosition})`); }
    else if (semrushData.avgPosition && semrushData.avgPosition < 50) { semScore += 5; boosts.push(`+5 decent avg pos`); }
    totalScore += semScore;
  }

  const normalizedScore = Math.round((totalScore / maxPossible) * 100);
  const grade = normalizedScore >= 85 ? 'A' : normalizedScore >= 70 ? 'B' : normalizedScore >= 55 ? 'C' : normalizedScore >= 40 ? 'D' : 'F';

  return { totalScore, maxPossible, normalizedScore, grade, boosts };
}

// ─── API Routes ────────────────────────────────────────────────

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (CREDENTIALS[username] && CREDENTIALS[username] === password) {
    const token = createSession(username);
    return res.json({ token, username });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// Apply auth middleware to all /api/* routes except /api/login
// Also support ?token= query param for SSE/download endpoints that can't send headers
app.use('/api/', (req, res, next) => {
  if (req.path === '/login') return next();
  // If no Authorization header but token in query string, inject it as a header
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  authMiddleware(req, res, next);
});

// List all state/cert combos
app.get('/api/pages', (req, res) => {
  const pages = [];
  for (const state of STATES) {
    for (const cert of CERTS) {
      pages.push({
        state,
        cert,
        slug: `${state}/${cert}`,
        url: `https://www.vitalrecordsonline.com/${state}/${cert}`,
        stateName: state.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
        certName: cert.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      });
    }
  }
  res.json({ pages, total: pages.length });
});

// Analyze a single page
app.get('/api/analyze/:state/:cert', async (req, res) => {
  const { state, cert } = req.params;
  const fullUrl = `/${state}/${cert}`;
  const liveUrl = `https://www.vitalrecordsonline.com${fullUrl}`;

  try {
    // 1. Fetch page from Payload
    const pageSearch = await payloadFetch(`/newpages?where[fullUrl][equals]=${encodeURIComponent(fullUrl)}&depth=1`);
    if (!pageSearch.docs?.length) {
      return res.json({ error: `Page not found: ${fullUrl}`, state, cert });
    }
    const page = pageSearch.docs[0];

    // 2. Fetch all layout blocks at depth
    const blockData = [];
    if (Array.isArray(page.layout)) {
      for (const lay of page.layout) {
        const blockId = typeof lay === 'string' ? lay : lay.id;
        try {
          const block = await payloadFetch(`/blocks/${blockId}?depth=6&draft=true`);
          blockData.push(block);
        } catch (e) { /* skip unreadable blocks */ }
      }
    }

    // 3. Scrape live page for H2s, meta, word count (source of truth for SEO)
    const liveData = await scrapeLivePage(liveUrl);

    // 4. On-page SEO score (uses live H2s/meta when available)
    const onPage = scoreOnPageSEO(page, blockData, liveData);

    // 5. Ahrefs data
    const ahrefs = await fetchAhrefsData(liveUrl);

    // 6. SERP position tracking using Ahrefs keyword data
    if (ahrefs.available && ahrefs.keywords && ahrefs.keywords.length > 0) {
      recordSerpPosition(liveUrl, ahrefs.keywords);
      const serpMovement = getSerpMovement(liveUrl, ahrefs.keywords);
      ahrefs.serpData = {
        keywords: serpMovement.keywords.slice(0, 10),
        dailyChange: serpMovement.dailyChange,
        weeklyChange: serpMovement.weeklyChange
      };
      ahrefs.keywordsTop1 = serpMovement.keywords.filter(k => k.position === 1).length;
      ahrefs.keywordsTop3 = serpMovement.keywords.filter(k => k.position <= 3).length;
      ahrefs.keywordsTop10 = serpMovement.keywords.filter(k => k.position <= 10).length;
      ahrefs.keywordsTop100 = serpMovement.keywords.filter(k => k.position <= 100).length;
    }

    // 7. SEMrush data (optional, skipped if no key)
    const semrush = await fetchSemrushData(liveUrl);

    // 8. Combined rating
    const rating = computeFinalRating(onPage, ahrefs, semrush);

    // 9. DeepSeek AI analysis (auto-run if API key is configured)
    let deepseek = { available: false };
    const dsKey = getSetting('deepseek_api_key', DEEPSEEK_KEY);
    if (dsKey) {
      deepseek = await runDeepSeekAnalysis({ state, cert, liveData, onPage });
    }

    const result = {
      state,
      cert,
      url: liveUrl,
      pageId: page.id,
      onPage,
      liveData: liveData.success ? { h2s: liveData.h2s, h3s: liveData.h3s, sections: liveData.sections, faqQuestions: liveData.faqQuestions, wordCount: liveData.wordCount } : null,
      ahrefs,
      semrush,
      deepseek,
      rating,
      analyzedAt: new Date().toISOString()
    };

    // Save to disk
    savePageResult(`${state}/${cert}`, result);

    res.json(result);

  } catch (e) {
    res.status(500).json({ error: e.message, state, cert });
  }
});

// Batch analyze multiple pages
app.post('/api/analyze-batch', async (req, res) => {
  const { pages } = req.body; // [{state, cert}, ...]
  if (!pages?.length) return res.status(400).json({ error: 'No pages provided' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  for (let i = 0; i < pages.length; i++) {
    const { state, cert } = pages[i];
    try {
      const fullUrl = `/${state}/${cert}`;
      const liveUrl = `https://www.vitalrecordsonline.com${fullUrl}`;
      const pageSearch = await payloadFetch(`/newpages?where[fullUrl][equals]=${encodeURIComponent(fullUrl)}&depth=1`);

      if (!pageSearch.docs?.length) {
        res.write(`data: ${JSON.stringify({ i, state, cert, error: 'Not found' })}\n\n`);
        continue;
      }

      const page = pageSearch.docs[0];
      const blockData = [];
      if (Array.isArray(page.layout)) {
        for (const lay of page.layout) {
          const blockId = typeof lay === 'string' ? lay : lay.id;
          try {
            const block = await payloadFetch(`/blocks/${blockId}?depth=6&draft=true`);
            blockData.push(block);
          } catch (e) { }
        }
      }

      const batchLiveData = await scrapeLivePage(liveUrl);
      const onPage = scoreOnPageSEO(page, blockData, batchLiveData);
      const ahrefs = await fetchAhrefsData(liveUrl);

      // Record SERP positions from Ahrefs
      if (ahrefs.available && ahrefs.keywords && ahrefs.keywords.length > 0) {
        recordSerpPosition(liveUrl, ahrefs.keywords);
        const serpMovement = getSerpMovement(liveUrl, ahrefs.keywords);
        ahrefs.keywordsTop1 = serpMovement.keywords.filter(k => k.position === 1).length;
        ahrefs.keywordsTop3 = serpMovement.keywords.filter(k => k.position <= 3).length;
        ahrefs.keywordsTop10 = serpMovement.keywords.filter(k => k.position <= 10).length;
        ahrefs.keywordsTop100 = serpMovement.keywords.filter(k => k.position <= 100).length;
      }

      const semrush = await fetchSemrushData(liveUrl);
      const rating = computeFinalRating(onPage, ahrefs, semrush);

      // DeepSeek AI analysis (auto-run if configured)
      let deepseek = { available: false };
      const batchDsKey = getSetting('deepseek_api_key', DEEPSEEK_KEY);
      if (batchDsKey) {
        deepseek = await runDeepSeekAnalysis({ state, cert, liveData: batchLiveData, onPage });
      }

      // Save full result to disk
      const fullResult = { state, cert, url: liveUrl, onPage, ahrefs, semrush, deepseek, rating, analyzedAt: new Date().toISOString() };
      savePageResult(`${state}/${cert}`, fullResult);

      res.write(`data: ${JSON.stringify({ i, state, cert, url: liveUrl, onPage, ahrefs: { available: ahrefs.available, keywordsTop1: ahrefs.keywordsTop1, keywordsTop3: ahrefs.keywordsTop3, keywordsTop10: ahrefs.keywordsTop10, keywordCount: ahrefs.keywordCount }, semrush: { available: semrush.available }, deepseek: { available: deepseek.available, quickWins: deepseek.analysis?.quickWins }, rating, analyzedAt: new Date().toISOString() })}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ i, state, cert, error: e.message })}\n\n`);
    }
  }

  res.write('data: {"done": true}\n\n');
  res.end();
});

// Load saved results from disk
app.get('/api/results', (req, res) => {
  res.json(loadResults());
});

// Save a snapshot for historical comparison
app.post('/api/snapshot', (req, res) => {
  snapshotHistory();
  const files = fs.readdirSync(HISTORY_DIR).sort();
  res.json({ saved: true, snapshots: files.length, latest: files[files.length - 1] });
});

// List history snapshots
app.get('/api/history', (req, res) => {
  const files = fs.readdirSync(HISTORY_DIR).sort().reverse();
  res.json({ snapshots: files });
});

// Check API connections
app.get('/api/status', async (req, res) => {
  const status = { payload: false, ahrefs: false, semrush: false, deepseek: false };

  // Payload
  try {
    const token = await getPayloadToken();
    status.payload = !!token;
  } catch (e) { }

  // Ahrefs
  status.ahrefs = !!AHREFS_TOKEN;

  // SEMrush
  status.semrush = !!SEMRUSH_KEY;

  // DeepSeek
  status.deepseek = !!(getSetting('deepseek_api_key', DEEPSEEK_KEY));

  res.json(status);
});

// ─── Settings (runtime API key management) ────────────────────
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({
    deepseek_api_key: s.deepseek_api_key ? '****' + s.deepseek_api_key.slice(-4) : (DEEPSEEK_KEY ? '****' + DEEPSEEK_KEY.slice(-4) : ''),
    ahrefs_token: AHREFS_TOKEN ? '****' + AHREFS_TOKEN.slice(-4) : '',
    semrush_key: SEMRUSH_KEY ? '****' + SEMRUSH_KEY.slice(-4) : '',
    deepseek_configured: !!(s.deepseek_api_key || DEEPSEEK_KEY),
    ahrefs_configured: !!AHREFS_TOKEN,
    semrush_configured: !!SEMRUSH_KEY
  });
});

app.post('/api/settings', (req, res) => {
  const { deepseek_api_key } = req.body;
  const s = loadSettings();
  if (deepseek_api_key !== undefined) s.deepseek_api_key = deepseek_api_key;
  saveSettings(s);
  res.json({ saved: true });
});

// ─── Scrape Live Page ─────────────────────────────────────────
app.get('/api/scrape/:state/:cert', async (req, res) => {
  const { state, cert } = req.params;
  const url = `https://www.vitalrecordsonline.com/${state}/${cert}`;
  const data = await scrapeLivePage(url);
  res.json(data);
});

// ─── Generate Markdown ────────────────────────────────────────
// Returns JSON with one file per category — client zips into state/cert/NN-category.md
app.get('/api/markdown/:state/:cert', async (req, res) => {
  const { state, cert } = req.params;
  const url = `https://www.vitalrecordsonline.com/${state}/${cert}`;
  const liveData = await scrapeLivePage(url);
  if (!liveData.success) return res.status(500).json({ error: liveData.error });

  let payloadMeta = {};
  try {
    const fullUrl = `/${state}/${cert}`;
    const pageSearch = await payloadFetch(`/newpages?where[fullUrl][equals]=${encodeURIComponent(fullUrl)}&depth=0`);
    if (pageSearch.docs?.length) payloadMeta = pageSearch.docs[0].meta || {};
  } catch(e) {}

  const filesMap = generateCategoryMarkdownFiles(state, cert, liveData, payloadMeta);
  const files = Object.entries(filesMap).map(([name, content]) => ({
    path: `${state}/${cert}/${name}`,
    content
  }));
  res.json({ state, cert, files });
});

// Stream all MD files as SSE — emits one event per page with an array of category files
app.get('/api/markdown-all', async (req, res) => {
  const states = req.query.states ? req.query.states.split(',') : STATES;
  const certs = req.query.certs ? req.query.certs.split(',') : CERTS;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  const total = states.length * certs.length;
  let done = 0;

  for (const state of states) {
    for (const cert of certs) {
      const url = `https://www.vitalrecordsonline.com/${state}/${cert}`;
      try {
        const liveData = await scrapeLivePage(url);
        if (liveData.success) {
          const filesMap = generateCategoryMarkdownFiles(state, cert, liveData, {});
          const files = Object.entries(filesMap).map(([name, content]) => ({
            path: `${state}/${cert}/${name}`,
            content
          }));
          res.write(`data: ${JSON.stringify({ state, cert, files, done: ++done, total })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ state, cert, error: liveData.error, done: ++done, total })}\n\n`);
        }
      } catch(e) {
        res.write(`data: ${JSON.stringify({ state, cert, error: e.message, done: ++done, total })}\n\n`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  res.write(`data: ${JSON.stringify({ complete: true, total: done })}\n\n`);
  res.end();
});

// ─── DeepSeek AI Analysis ─────────────────────────────────────
app.post('/api/deepseek-analyze', async (req, res) => {
  const { state, cert } = req.body;
  if (!state || !cert) return res.status(400).json({ error: 'state and cert required' });

  const url = `https://www.vitalrecordsonline.com/${state}/${cert}`;
  const liveData = await scrapeLivePage(url);
  const saved = loadResults();
  const onPage = saved[`${state}/${cert}`]?.onPage || {};

  const result = await runDeepSeekAnalysis({ state, cert, liveData, onPage });
  res.json(result);
});

// Export results as CSV
app.post('/api/export-csv', (req, res) => {
  const { results } = req.body;
  if (!results?.length) return res.status(400).json({ error: 'No results' });

  const header = 'State,Certificate,URL,On-Page Score,Grade,Word Count,FAQ Count,H2 Count,Issues,Ahrefs Traffic,SEMrush Keywords,Keywords #1,Keywords #1-3,Keywords #1-10,Final Score,Final Grade,Analyzed At\n';
  const rows = results.map(r => {
    const op = r.onPage || {};
    const ah = r.ahrefs || {};
    const sm = r.semrush || {};
    const rt = r.rating || {};
    return [
      r.state, r.cert, r.url,
      op.total, op.grade, op.meta?.wordCount, op.meta?.faqCount, op.meta?.h2s?.length,
      (op.issues || []).length,
      ah.organicTraffic || '', sm.keywordCount || '',
      sm.keywordsTop1 || 0, sm.keywordsTop3 || 0, sm.keywordsTop10 || 0,
      rt.normalizedScore, rt.grade,
      r.analyzedAt
    ].join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=vro-seo-analysis.csv');
  res.send(header + rows);
});

// ─── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🔍 VRO SEO Analyzer running at http://localhost:${PORT}\n`);
  console.log(`  Payload CMS:  ${PAYLOAD_BASE}`);
  console.log(`  Ahrefs API:   ${AHREFS_TOKEN ? '✓ configured' : '✗ not configured'}`);
  console.log(`  SEMrush API:  ${SEMRUSH_KEY ? '✓ configured' : '✗ not configured'}`);
  console.log(`  DeepSeek API: ${getSetting('deepseek_api_key', DEEPSEEK_KEY) ? '✓ configured' : '✗ not configured'}`);
  console.log(`  Data storage:  ${DATA_DIR}${process.env.DATA_PATH ? ' (persistent volume)' : ' (ephemeral - add DATA_PATH for persistence)'}`);
  console.log(`  Live scraping: ✓ enabled (H2s, meta, content from live website)\n`);
});
