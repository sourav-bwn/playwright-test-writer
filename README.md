# Plain-English Playwright Test Writer

Ziro Agentic AI Hackathon 2026 - Developer & Enterprise AI track.

**What it does:** you type a flow in plain English ("Test that a user can sign up and see the dashboard"). The agent:

1. **Collects the details** - the flow description and the expected end state.
2. **Finds the information** - fetches the live sign-up page of the app under test and reads its real fields and selectors (stored as evidence with source URL + retrieval time).
3. **Plans the next steps** - chooses stable selectors (`data-testid` first) and real assertions. A URL-only check is rejected as weak and upgraded to state assertions.
4. **Takes action** - writes a Playwright test file, then waits for **human approval** before running it. After the run it **reruns the test to check stability**.

Output: the test file plus the run result, in plain English.

## The demo target

A small open-source demo app is built in (`/demo`): a sign-up page and a dashboard.
`v1` is the normal app; `v2` simulates a redesign that renamed the submit
button, so you can watch a test fail with a clear explanation when a selector
changes. Mock data only; every run generates a fresh timestamped email, and the
test asserts no duplicate account is created.

## Run it

```bash
npm install
npx playwright install --with-deps chromium
npm start
# open http://localhost:3000
```

Set `GEMINI_API_KEY` to let Gemini write the plan (free tier is enough).
Without a key, a deterministic built-in planner takes over so the agent still works.

## Test cases

| # | Scenario | Expected |
|---|----------|----------|
| TC1 | "user signs up and sees the dashboard" against v1 | Passes; asserts the dashboard welcome and that the new user record exists |
| TC2 | same flow against v2 (button renamed) | Fails with a clear message naming the missing element |
| TC3 | "only check the URL" | Agent rejects the weak test and upgrades to state assertions |
| TC4 | rerun any test | Fresh mock data each run; asserts no duplicate account |

## Deploy (Render free tier, Docker)

Render's native Node environment cannot install Chromium's system
dependencies, so this repo ships a `Dockerfile` based on the official
Playwright image (browser + all system libraries included).

- New Web Service -> this repo -> Runtime: **Docker** -> plan: **Free**
- Env: `GEMINI_API_KEY` (optional), `GEMINI_MODEL` (default `gemini-2.5-flash`)
