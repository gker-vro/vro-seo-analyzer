require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ────────────────────────────────────────────────────────
const PAYLOAD_BASE = process.env.PAYLOAD_BASE_URL || 'https://www.vitalrecordsonline.com';
const PAYLOAD_API  = process.env.PAYLOAD_API_PATH  || '/api-cms';
const PAYLOAD_URL  = `${PAYLOAD_BASE}${PAYLOAD_API}`;
const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN  || '';
const SEMRUSH_KEY  = process.env.SEMRUSH_API_KEY   || '';
const PORT         = process.env.PORT || 3847;

let payloadToken = null;
let tokenExpiry  = 0;

// ─── Persistent Storage ────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const HISTORY_DIR  = path.join(DATA_DIR, 'history');

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

// ─── States & Certs ────────────────────────────────────────────────
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

// ─── Payload Auth ──────────────────────────────────────────────────
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

// ─── On-Page SEO Scoring Engine ────────────────────────────────────
function scoreOnPageSEO(pageData, blockData) {
  const scores = {};
  const issues = [];
  const state = pageData.slug || '';
  const fullUrl = pageData.fullUrl || '';

  // --- 1. Meta Title (15 pts) ---
  const metaTitle = pageData.meta?.title || pageData.title || '';
  if (!metaTitle) {
    scores.metaTitle = 0;  issues.push({ severity: 'critical', msg: 'Missing meta title' });
  } else if (metaTitle.length < 30) {
    scores.metaTitle = 5;  issues.push({ severity: 'warning', msg: `Meta title too short (${metaTitle.length} chars)` });
  } else if (metaTitle.length > 60) {
    scores.metaTitle = 8;  issues.push({ severity: 'warning', msg: `Meta title too long (${metaTitle.length} chars)` });
  } else {
    scores.metaTitle = 15;
  }

  // --- 2. Meta Description (10 pts) ---
  const metaDesc = pageData.meta?.description || '';
  if (!metaDesc) {
    scores.metaDesc = 0;  issues.push({ severity: 'critical', msg: 'Missing meta description' });
  } else if (metaDesc.length < 70) {
    scores.metaDesc = 3;  issues.push({ severity: 'warning', msg: `Meta description too short (${metaDesc.length} chars)` });
  } else if (metaDesc.length > 160) {
    scores.metaDesc = 5;  issues.push({ severity: 'warning', msg: `Meta description too long (${metaDesc.length} chars)` });
  } else {
    scores.metaDesc = 10;
  }

  // --- 3. H1 (10 pts) ---
  const h1s = extractHeadings(blockData, 'h1');
  if (h1s.length === 0) {
    scores.h1 = 0;  issues.push({ severity: 'critical', msg: 'Missing H1 heading' });
  } else if (h1s.length > 1) {
    scores.h1 = 5;  issues.push({ severity: 'warning', msg: `Multiple H1s found (${h1s.length})` });
  } else {
    scores.h1 = 10;
  }

  // --- 4. H2 Quality (15 pts) ---
  const h2s = extractHeadings(blockData, 'h2');
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

  // --- 5. Content Length (10 pts) ---
  const contentText = extractAllText(blockData);
  const wordCount = contentText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 300) {
    scores.contentLength = 2;  issues.push({ severity: 'critical', msg: `Thin content (${wordCount} words)` });
  } else if (wordCount < 600) {
    scores.contentLength = 5;  issues.push({ severity: 'warning', msg: `Content could be longer (${wordCount} words)` });
  } else if (wordCount < 1000) {
    scores.contentLength = 8;
  } else {
    scores.contentLength = 10;
  }

  // --- 6. FAQ Section (20 pts) ---
  const faqData = extractFAQs(blockData);
  if (faqData.count === 0) {
    scores.faq = 0;  issues.push({ severity: 'critical', msg: 'No FAQ section found' });
  } else if (faqData.count < 5) {
    scores.faq = 5;  issues.push({ severity: 'warning', msg: `Only ${faqData.count} FAQs (target: 8-10)` });
  } else if (faqData.count < 8) {
    scores.faq = 10;  issues.push({ severity: 'info', msg: `${faqData.count} FAQs found (good, target: 8-10)` });
  } else {
    scores.faq = 20;
  }

  // --- 7. Internal Linking (10 pts) ---
  const links = extractLinks(blockData);
  const internalLinks = links.filter(l => l.includes('vitalrecordsonline.com') || l.startsWith('/'));
  if (internalLinks.length === 0) {
    scores.internalLinks = 0;  issues.push({ severity: 'warning', msg: 'No internal links found' });
  } else if (internalLinks.length < 3) {
    scores.internalLinks = 5;
  } else {
    scores.internalLinks = 10;
  }

  // --- 8. Image Optimization (5 pts) ---
  const images = extractImages(blockData);
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
    meta: { metaTitle, metaDesc, h1s, h2s, wordCount, faqCount: faqData.count, faqQuestions: faqData.questions, internalLinkCount: internalLinks.length, imageCount: images.length }
  };
}

// ─── Block Traversal Helpers ───────────────────────────────────────
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

// ─── Ahrefs API ────────────────────────────────────────────────────
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

    return {
      available: true,
      domainRating: metrics.metrics?.domain_rating || null,
      organicKeywords: kwData.keywords || [],
      organicTraffic: kwData.metrics?.organic_traffic || 0,
      backlinks: blData.metrics?.live || 0,
      referringDomains: blData.metrics?.live_refdomains || 0
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// ─── SEMrush API ───────────────────────────────────────────────────
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

// ─── Combined Score ────────────────────────────────────────────────
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

// ─── API Routes ────────────────────────────────────────────────────

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

    // 3. On-page SEO score
    const onPage = scoreOnPageSEO(page, blockData);

    // 4. Ahrefs data
    const ahrefs = await fetchAhrefsData(liveUrl);

    // 5. SEMrush data
    const semrush = await fetchSemrushData(liveUrl);

    // 6. Combined rating
    const rating = computeFinalRating(onPage, ahrefs, semrush);

    const result = {
      state,
      cert,
      url: liveUrl,
      pageId: page.id,
      onPage,
      ahrefs,
      semrush,
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

      const onPage = scoreOnPageSEO(page, blockData);
      const ahrefs = await fetchAhrefsData(liveUrl);
      const semrush = await fetchSemrushData(liveUrl);
      const rating = computeFinalRating(onPage, ahrefs, semrush);

      res.write(`data: ${JSON.stringify({ i, state, cert, url: liveUrl, onPage, ahrefs: { available: ahrefs.available }, semrush: { available: semrush.available }, rating, analyzedAt: new Date().toISOString() })}\n\n`);
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
  const status = { payload: false, ahrefs: false, semrush: false };

  // Payload
  try {
    const token = await getPayloadToken();
    status.payload = !!token;
  } catch (e) { }

  // Ahrefs
  status.ahrefs = !!AHREFS_TOKEN;

  // SEMrush
  status.semrush = !!SEMRUSH_KEY;

  res.json(status);
});

// Export results as CSV
app.post('/api/export-csv', (req, res) => {
  const { results } = req.body;
  if (!results?.length) return res.status(400).json({ error: 'No results' });

  const header = 'State,Certificate,URL,On-Page Score,Grade,Word Count,FAQ Count,H2 Count,Issues,Ahrefs Traffic,SEMrush Keywords,Final Score,Final Grade,Analyzed At\n';
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
      rt.normalizedScore, rt.grade,
      r.analyzedAt
    ].join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=vro-seo-analysis.csv');
  res.send(header + rows);
});

// ─── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🔍 VRO SEO Analyzer running at http://localhost:${PORT}\n`);
  console.log(`  Payload CMS: ${PAYLOAD_BASE}`);
  console.log(`  Ahrefs API:  ${AHREFS_TOKEN ? '✓ configured' : '✗ not configured'}`);
  console.log(`  SEMrush API: ${SEMRUSH_KEY ? '✓ configured' : '✗ not configured'}\n`);
});
