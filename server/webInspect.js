// Generic, read-only page inspection for user-named external targets.
// Safety: http(s) only, no private/loopback/link-local hosts, bounded
// redirects, timeout and size caps. No form is ever submitted here -
// inspection only reads the page, exactly like a browser viewing it.
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = Number(process.env.INSPECT_TIMEOUT_MS) || 15000;

function isPublicIp(ip) {
  if (net.isIPv6(ip)) {
    const n = ip.toLowerCase();
    return !(n === '::1' || n.startsWith('fe80:') || n.startsWith('fc') || n.startsWith('fd') || n === '::');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return false;
  return !(
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224 // multicast/reserved
  );
}

async function assertPublicHost(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new Error('That address is not allowed: only public websites can be inspected.');
  }
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('That address is not allowed: only public websites can be inspected.');
    return;
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve the host "${hostname}".`);
  }
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) {
    throw new Error('That address is not allowed: it resolves to a private network address.');
  }
}

const attr = (tag, name) => (tag.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || null;
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Read a page and describe what's actually there: title, forms with their
// fields and buttons, and links. Everything is recorded as evidence with the
// source URL, HTTP status and UTC retrieval time.
export async function inspectPage(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('That does not look like a valid URL. Include https:// and the full address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http:// and https:// pages can be inspected.');
  }
  if (!allowPrivate) await assertPublicHost(url.hostname);

  const retrievedAt = new Date().toISOString();
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'TestPilotAI-Inspector/1.0 (read-only page check)', Accept: 'text/html,*/*' },
  });
  const reader = res.body?.getReader?.();
  let html = '';
  if (reader) {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) break;
      chunks.push(value);
    }
    html = Buffer.concat(chunks).toString('utf8');
    try { await reader.cancel(); } catch {}
  } else {
    html = (await res.text()).slice(0, MAX_BYTES);
  }

  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const h1 = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);

  const forms = [];
  const formRe = /<form[^>]*>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    const openTag = fm[0].slice(0, fm[0].indexOf('>') + 1);
    const inputs = [];
    for (const tag of fm[1].match(/<input[^>]*>/gi) || []) {
      inputs.push({ name: attr(tag, 'name'), type: (attr(tag, 'type') || 'text').toLowerCase(), id: attr(tag, 'id'), testId: attr(tag, 'data-testid'), required: /\srequired(\s|=|\/|>|$)/i.test(tag) });
    }
    const buttons = [];
    for (const bm of fm[1].matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)) {
      buttons.push({ type: (attr(bm[0].slice(0, bm[0].indexOf('>') + 1), 'type') || 'submit').toLowerCase(), label: stripTags(bm[1]).slice(0, 80), testId: attr(bm[0].slice(0, bm[0].indexOf('>') + 1), 'data-testid') });
    }
    forms.push({
      action: attr(openTag, 'action'),
      method: (attr(openTag, 'method') || 'get').toLowerCase(),
      inputs,
      buttons,
      hasPassword: inputs.some((i) => i.type === 'password'),
      // OTP/CAPTCHA guardrail: never generate tests that bypass these.
      hasCaptcha: /captcha|recaptcha|hcaptcha|turnstile/i.test(fm[1]),
      hasOtp: inputs.some((i) => /otp|2fa|totp|verification/i.test(i.name || '') || /otp|2fa|totp/i.test(i.id || '')),
    });
  }

  const links = [];
  for (const lm of html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(lm[2]).slice(0, 60);
    if (text && links.length < 30) links.push({ text, href: lm[1].slice(0, 200) });
  }

  const headings = [];
  for (const hm of html.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)) {
    const t = stripTags(hm[1]).slice(0, 80);
    if (t && headings.length < 12) headings.push(t);
  }

  return {
    source: { url: url.toString(), finalUrl: res.url, retrievedAt, httpStatus: res.status },
    title,
    h1,
    forms,
    links,
    headings,
    bytesRead: html.length,
    truncated: html.length >= MAX_BYTES,
  };
}

// Read-only check ideas a named page can support without changing any state.
// Anything that submits a form is intentionally NOT in this list.
export function readOnlyCheckIdeas(inspection) {
  const ideas = [{ id: 'page-loads', label: 'The page loads successfully (HTTP 2xx)' }];
  if (inspection.title) ideas.push({ id: 'title-contains', label: `The page title contains "${inspection.title.slice(0, 40)}"` });
  if (inspection.h1) ideas.push({ id: 'heading-visible', label: `A heading "${inspection.h1.slice(0, 40)}" is visible` });
  for (const h of inspection.headings.slice(1, 4)) ideas.push({ id: 'heading-visible', label: `The heading "${h.slice(0, 40)}" is visible` });
  for (const l of inspection.links.slice(0, 4)) ideas.push({ id: 'link-visible', label: `A link "${l.text.slice(0, 40)}" is visible` });
  if (inspection.forms.length) ideas.push({ id: 'form-present', label: 'The form is present with its fields (no submission)' });
  return ideas;
}
