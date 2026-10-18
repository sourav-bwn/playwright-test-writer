// "Find the information": fetch the real sign-up page and read its fields,
// so the generated test uses selectors that exist right now. Every inspection
// is stored as evidence with the source URL and retrieval time.
export async function inspectSignupPage(baseUrl, version = 'v1') {
  const url = `${baseUrl}/demo/${version}/signup`;
  const retrievedAt = new Date().toISOString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const html = await res.text();

  const fields = [];
  const inputRe = /<input[^>]*>/g;
  for (const tag of html.match(inputRe) || []) {
    const get = (attr) => (tag.match(new RegExp(`${attr}="([^"]*)"`)) || [])[1];
    fields.push({
      name: get('name'),
      type: get('type') || 'text',
      id: get('id'),
      testId: get('data-testid'),
      required: /required/.test(tag),
    });
  }
  const buttonTag = (html.match(/<button[^>]*>[^<]*<\/button>/) || [''])[0];
  const getBtn = (attr) => (buttonTag.match(new RegExp(`${attr}="([^"]*)"`)) || [])[1];
  const submit = {
    id: getBtn('id'),
    testId: getBtn('data-testid'),
    label: (buttonTag.match(/>([^<]*)</) || [])[1] || '',
  };

  return {
    source: { url, retrievedAt, httpStatus: res.status },
    fields,
    submit,
    // Stable-selector policy: data-testid first, then id.
    selectors: {
      name: fields.find((f) => f.name === 'name')?.testId || 'name-input',
      email: fields.find((f) => f.name === 'email')?.testId || 'email-input',
      password: fields.find((f) => f.name === 'password')?.testId || 'password-input',
      submit: submit.testId || submit.id || 'signup-submit',
    },
  };
}
