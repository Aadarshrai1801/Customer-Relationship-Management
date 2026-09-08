# Command Palette – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000` (palette is pure frontend – no curl; use UI steps + localStorage checks instead).

## 1. Overview

This guide covers Global Command Palette (`Cmd+K` / `Ctrl+K`): fuzzy navigation, search across records, and quick actions – pure frontend with local indexes + API-backed search where present.
Scope includes open/close gestures, fuzzy matching, keyboard navigation, sections (Go to, Records, Actions), recent/history, scoped results per permissions, empty/no-result states, performance with large indexes, theming/responsive, and persistence (recents in localStorage).
Out of scope is full global search relevance tuning beyond palette, but parity with list search is checked.
Key roles: palette respects viewer permissions (only searchable records shown); admin sees admin destinations (e.g., Billing, Workflows).
Critical rules: opens <100ms; every result keyboard-reachable; `Esc` closes with focus return; actions execute same APIs as buttons; no leakage of unauthorized records via client index.
Success criteria: 18+ cases pass, keyboard matrix green, recent persistence works, and unauthorized records never surface.

## 2. Prerequisites & Test Data Setup

- App running Web `http://localhost:3000` logged in as rep1 (owns `Acme`, `DEAL-01`), plus rep2 private record `Stealth Co` (rep1 must NOT see), admin for admin destinations.
- Data: at least 20 contacts, 10 deals, 5 companies with distinctive names (`Acme Big Co`, `Beta-ß Coop`, `Gamma, Quoted`) for fuzzy tests.
- Browser: Chrome + Firefox + Safari if available; keyboard (physical) required; clear `localStorage` once to test cold recents.
- localStorage keys to inspect (adapt to impl, document actuals): e.g., `crm.palette.recents`, `crm.palette.lastQuery`; use DevTools → Application.
- Note search mode: local-only vs API-debounced (`/api/search?q=`) – record via Network tab; note debounce ms.
- Cleanup: clear QA recents after run (`localStorage.removeItem(...)`).

## 3. Test Environment Matrix

| Dimension   | Variants                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------- |
| OS/shortcut | macOS `Cmd+K`, Windows/Linux `Ctrl+K`, `Ctrl+P` alias if present, Click trigger (🔍 button) |
| Browser     | Chrome, Firefox, Edge, Safari                                                               |
| Viewport    | 1440px centered modal, 768px, 375px full-sheet                                              |
| Role/scope  | Rep (own), Manager (team), Admin (all + admin pages), Viewer (limited actions)              |
| Query       | Empty (recents), Prefix, Fuzzy typo, Unicode, Special chars, Long 200 chars                 |
| Index size  | Small (30), Medium (500 via seed), Large (5k – perf)                                        |
| Theme       | Light/Dark                                                                                  |
| Input       | Keyboard-only, Mouse-only, Mixed                                                            |

- Record: OS, browser, shortcut used, query strings, result counts, timings, localStorage snapshots.
- Test with network offline to prove local destinations still work (records may degrade – document).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Open via Cmd/Ctrl+K (<100ms)

- **Objective:** Verify shortcut opens instantly from anywhere.
- **Preconditions:** Logged in; focus in body (not input).
- **Steps:**
  1. Press `Cmd+K` (mac) / `Ctrl+K` (win).
  2. Verify palette modal appears with input autofocused + `Recent / Suggested` when empty.
  3. Measure open latency (perceived instant; DevTools Perf if needed).
  4. Repeat from Deal detail, Reports, Settings.
- **Expected:** Opens everywhere <100ms; input focused.

### TC-02 – Open via Click Affordance

- **Objective:** Verify mouse path.
- **Preconditions:** Header shows search button `Search or command… ⌘K`.
- **Steps:**
  1. Click button.
  2. Verify same modal as TC-01.
  3. Verify button label hints shortcut.
- **Expected:** Parity; discoverable.

### TC-03 – Close: Esc, Backdrop, Shortcut Toggle

- **Objective:** Verify all close paths + focus return.
- **Preconditions:** Palette open from a Deals row button (focused element remembered).
- **Steps:**
  1. Press `Esc`; verify closes + focus returns to trigger.
  2. Reopen; click backdrop; verify closes + focus returns.
  3. Reopen; press `Cmd+K` again; verify toggles closed.
- **Expected:** All close; focus restored (a11y).

### TC-04 – Keyboard Test Matrix (Core)

- **Objective:** Verify full keyboard operation.
- **Preconditions:** Palette open with results for `ac`.
- **Steps:**
  1. `↑/↓` moves active result (wraps at ends – document).
  2. `Enter` navigates/executes active.
  3. `Tab` (if trapped) cycles within modal, not behind.
  4. Type more chars narrows; `Backspace` to empty shows recents.
  5. `Esc` closes.
- **Expected:** Matrix: Arrows ✓, Enter ✓, Esc ✓, Tab trapped ✓. Log any deviation.

| Key              | Context       | Expected                    |
| ---------------- | ------------- | --------------------------- |
| `Cmd/Ctrl+K`     | Anywhere      | Open / toggle               |
| `Esc`            | Open          | Close + focus return        |
| `↑/↓`            | Results       | Move active, scrollIntoView |
| `Enter`          | Active result | Go / execute                |
| `Tab/Shift+Tab`  | Open          | Trap inside modal           |
| `Backspace`      | Empty query   | Show recents                |
| `Ctrl+C`/`Cmd+C` | Input         | Copy (not close)            |

### TC-05 – Fuzzy Match (Typo Tolerance)

- **Objective:** Verify `amce` finds `Acme`.
- **Preconditions:** `Acme Big Co` exists.
- **Steps:**
  1. Type `amce`.
  2. Verify `Acme Big Co` in top 3 with highlight on matched chars.
  3. Type `acme big`; verify narrows to one.
  4. Type `zzzz-no-match`; verify empty state (TC-12).
- **Expected:** Tolerant; highlights; ranking sensible.

### TC-06 – Prefix / Exact / Case-Insensitive

- **Objective:** Verify basic matching rules.
- **Preconditions:** `Beta Coop`, `beta tester`.
- **Steps:**
  1. Type `BETA` (upper); verify both found (case-insensitive).
  2. Type full `Beta Coop`; verify exact tops.
  3. Type `Coop Beta` (reordered); verify still found if fuzzy, else empty – document.
- **Expected:** Case-insensitive; exact ranks first.

### TC-07 – Unicode & Special Characters

- **Objective:** Verify `ß`, commas, quotes.
- **Preconditions:** `Beta-ß Coop`, `Gamma, "Quoted"`.
- **Steps:**
  1. Type `ß`; verify `Beta-ß` found.
  2. Type `Gamma,`; verify quoted found.
  3. Paste `"`; verify no regex crash.
- **Expected:** No crash; correct hits.

### TC-08 – Sections: Go To vs Records vs Actions

- **Objective:** Verify grouped results with headers.
- **Preconditions:** Query `deal`.
- **Steps:**
  1. Verify headers `Go to` (pages: Deals, Reports), `Records` (DEAL-01…), `Actions` (New Deal).
  2. Arrow through sections; verify group labels announced (aria).
  3. Verify `Go to Deals` navigates to list, not a record.
- **Expected:** Grouped; navigation correct per section.

### TC-09 – Quick Actions Execute (New Deal/Task/Contact)

- **Objective:** Verify actions parity with buttons.
- **Preconditions:** Palette open, query `new deal`.
- **Steps:**
  1. Select `New Deal…`; verify deal modal opens (palette closes).
  2. Create `[QA-Palette] Deal`; verify toast + lands on detail.
  3. Repeat `New Task` → appears in Today's focus.
- **Expected:** Same APIs as Home buttons; results appear in lists.

### TC-10 – Recent / History Persists (localStorage)

- **Objective:** Verify recents aid repeat nav.
- **Preconditions:** Cleared recents.
- **Steps:**
  1. Clear `localStorage` key `crm.palette.recents` (document actual key).
  2. Open `DEAL-01` via palette → Enter.
  3. Reopen empty palette; verify `Recent: DEAL-01` tops.
  4. Reload page; verify recents persist.
  5. Inspect `localStorage.getItem('crm.palette.recents')` contains deal ID + timestamp.
- **Expected:** Persists across reload; capped (e.g., 10 – document).

### TC-11 – Permissions: Private Records Hidden

- **Objective:** Verify no leakage via index.
- **Preconditions:** `Stealth Co` visible only rep2.
- **Steps:**
  1. As rep1 type `Stealth`; verify zero hits + no preview.
  2. Inspect Network/local index for `Stealth` string – must be absent (or API filtered).
  3. As rep2 same query → found.
- **Expected:** Strict filter; index per-user or API-scoped.

### TC-12 – No-Result State Guides

- **Objective:** Verify helpful empty.
- **Preconditions:** Query `zzzz-no-such-thing-qa`.
- **Steps:**
  1. Verify illustration + `No results for "…" – Try different keywords or create`.
  2. Verify `Create …` action offered where sensible (e.g., New Contact).
  3. Clear query; verify recents return.
- **Expected:** Guided; not dead-end.

### TC-13 – Debounce + API Search (if hybrid)

- **Objective:** Verify network behavior sane.
- **Preconditions:** Network tab open.
- **Steps:**
  1. Type `a` → `ac` → `acm` rapidly.
  2. Verify ≤1–2 `/api/search?q=` calls (debounced ~150–300ms), not per keystroke.
  3. Verify stale responses ignored (results match final query).
- **Expected:** Debounced; no race flicker. If local-only, verify zero calls + document.

### TC-14 – Offline Degrades Gracefully

- **Objective:** Verify palette useful offline.
- **Preconditions:** Go offline (DevTools).
- **Steps:**
  1. Open palette; verify destinations (`Go to…`) + recents still work.
  2. Search records → either cached results or `You're offline – showing recents` notice.
  3. Go online; verify live results return.
- **Expected:** No crash; clear notice.

### TC-15 – Performance with 5k Records

- **Objective:** Verify typing stays <100ms/key.
- **Preconditions:** 5k seeded (staging).
- **Steps:**
  1. Type `a`; measure first paint of results.
  2. Verify virtualized list (DOM nodes capped, scroll loads more) or `Top 20 + View all`.
  3. Verify no input lag (type full `acme big co` fluidly).
- **Expected:** <300ms paint; no jank; capped render.

### TC-16 – Responsive 375px Full-Sheet

- **Objective:** Verify mobile sheet usable.
- **Preconditions:** 375px viewport.
- **Steps:**
  1. Open palette; verify full-width sheet, large input, results scroll.
  2. Tap result; verify navigates + sheet closes.
  3. Verify shortcut hint hidden or shows touch alternative.
- **Expected:** Thumb-friendly; no horizontal scroll.

### TC-17 – Dark Mode + Reduced Motion

- **Objective:** Verify parity.
- **Preconditions:** Dark + `prefers-reduced-motion: reduce` (emulate).
- **Steps:**
  1. Dark: verify input, groups, highlights, selected-row contrast AA.
  2. Reduced-motion: verify open has no slide/scale animation (instant).
- **Expected:** Legible; motion respected.

### TC-18 – Screen-Reader & Focus Trap

- **Objective:** Verify a11y.
- **Preconditions:** Keyboard + axe + (VoiceOver/NVDA if available).
- **Steps:**
  1. Verify `role=dialog aria-label=Command palette`, input `aria-activedescendant`, results `role=option`.
  2. Arrow announces options; Enter activates.
  3. Tab never escapes behind modal; axe 0 critical.
- **Expected:** Announced; trapped; labelled.

### TC-19 – Long Query + Paste + Clear

- **Objective:** Verify input robustness.
- **Preconditions:** Palette open.
- **Steps:**
  1. Paste 200-char string; verify truncated gracefully or scrolls, no freeze.
  2. Press `Ctrl+K` then `Esc` mid-paste – no stuck state.
  3. Click `× Clear`; verify returns to recents.
- **Expected:** No freeze; clear works.

## 5. UI Steps + localStorage Checks (No curl – Pure Frontend)

Palette is client-side; validate via UI + storage instead of HTTP.

| Check                     | Steps                                            | Expected localStorage / UI                                                                             |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Open/close                | `Cmd+K`, `Esc`, backdrop, toggle                 | Modal mounts/unmounts; `document.activeElement` returns to trigger                                     |
| Recents persist           | Open 3 records via palette → reload → open empty | `localStorage['crm.palette.recents']` (actual key documented) holds 3 IDs with `at` timestamps, capped |
| Last query (if stored)    | Type `acme`, close, reopen                       | Either cleared (preferred) or restored – document; never leaks across users (cleared on logout)        |
| Logout clears user-scoped | Logout as rep1 → login rep2 → open empty         | No rep1 recents shown; key namespaced by userId or cleared                                             |
| Performance               | Type rapidly with Perf record                    | Input handler <16ms/frame; results paint <300ms                                                        |
| Offline                   | DevTools Offline → open                          | Destinations + recents render; `navigator.onLine===false` notice                                       |

```js
// Run in DevTools Console on http://localhost:3000
localStorage.length;
Object.keys(localStorage).filter((k) => k.toLowerCase().includes('palette'));
JSON.parse(localStorage.getItem('crm.palette.recents') || '[]');
localStorage.removeItem('crm.palette.recents'); // cleanup QA recents
document.activeElement; // after Esc should be trigger, not body
```

- Document ACTUAL keys found (they may be `palette:recent`, `cmdk:history`, etc.) – update this file with findings.
- Assert: no private record IDs/strings in `localStorage` or inlined index for unauthorized user (search `Stealth` in Sources).

## 6. UI Testing Section

- Trigger: header search field/button with `⌘K` kbd hint; hover/focus states; hidden on <360px behind icon (document).
- Modal: centered 640px (desktop), overlay blur, input with 🔍 + `Esc` hint + clear ×, grouped results with icons (📄 record, 🧭 page, ⚡ action), footer hints (`↑↓ navigate · Enter open · Esc close`).
- Highlight: matched substring bold/accent; selected row filled; avatars/initials for people.
- Loading: shimmer rows on API search; `Searching…` aria-live.
- Empty: illustration + suggestion + create-action.
- Dark/responsive: tokens adapt; 375px sheet slides up; backdrop locks body scroll.
- Motion: 120ms fade/scale (disabled under reduced-motion).

## 7. Regression & Cross-Feature Impact

- Navigation: every `Go to` matches sidebar route; renamed routes must update palette index.
- Records: new/renamed deals/contacts appear within cache window (or instantly – document invalidation).
- Quick actions: same validation/toasts/audit as buttons; viewer hides disallowed actions.
- Auth: logout clears user-scoped recents/index; switching user never shows prior recents.
- Theming/shell: modal z-index above sidebar/toasts; breadcrumbs update after palette nav.
- Search API: palette query encoding matches list search (unicode/quote handling shared).

## 8. Expected Results Summary Table

| TC    | Title            | Expected                  | Severity |
| ----- | ---------------- | ------------------------- | -------- |
| TC-01 | Open shortcut    | <100ms everywhere         | Critical |
| TC-02 | Click open       | Parity                    | Minor    |
| TC-03 | Close paths      | Focus return              | Major    |
| TC-04 | Keyboard matrix  | All green                 | Critical |
| TC-05 | Fuzzy typo       | Top-3 hit                 | Major    |
| TC-06 | Case/exact       | Insensitive + exact first | Minor    |
| TC-07 | Unicode/special  | No crash                  | Minor    |
| TC-08 | Sections         | Grouped correct           | Major    |
| TC-09 | Quick actions    | Execute + surface         | Major    |
| TC-10 | Recents persist  | Reload-proof, capped      | Major    |
| TC-11 | Private hidden   | No leak                   | Critical |
| TC-12 | No-result guides | CTA + clear               | Minor    |
| TC-13 | Debounce         | ≤2 calls burst            | Major    |
| TC-14 | Offline          | Recents + notice          | Minor    |
| TC-15 | 5k perf          | <300ms, virtualized       | Major    |
| TC-16 | Mobile sheet     | Usable                    | Minor    |
| TC-17 | Dark/motion      | AA + respected            | Minor    |
| TC-18 | SR/trap          | Announced + trapped       | Major    |
| TC-19 | Long/paste/clear | No freeze                 | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                      | Cause                                                                   | Fix                                                                           |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Cmd+K` types `k` in input   | Listener on `keydown` without `preventDefault` / focused input swallows | Check handler scope; allow only when not in text field or use `metaKey` guard |
| Palette empty always         | Index not built (async fail) / API 401                                  | Check console + Network `search`; rebuild index; re-login                     |
| Private record surfaces      | Client ships global index                                               | Scope index per user or force API search; file sec bug                        |
| Stale names after rename     | Index cache not invalidated                                             | Invalidate on mutation; document TTL                                          |
| Enter does nothing           | Active index −1 (no selection default)                                  | Auto-select first on results; verify `aria-activedescendant`                  |
| Focus lost after close       | No return-focus                                                         | Store trigger; `.focus()` on unmount                                          |
| Typing lag with 5k           | Full render per keystroke                                               | Virtualize + debounce + limit 20                                              |
| Shortcut conflicts (browser) | `Ctrl+K` hijacked                                                       | Support `Ctrl+P` alias + clickable; document                                  |

- Debug: `localStorage` recents dump, Sources search for leaked names, Perf flame for input handler, Network `search?q=` waterfall.
- Reset: clear recents key; reload; re-login to rebuild index.

## 10. Pass/Fail Checklist

- [ ] Opens via shortcut + click everywhere <100ms; closes via Esc/backdrop/toggle with focus return.
- [ ] Keyboard matrix (arrows/enter/tab/esc) fully green.
- [ ] Fuzzy/typo, case-insensitive, unicode/special all behave; highlights correct.
- [ ] Sections grouped; quick actions execute and surface in lists/focus.
- [ ] Recents persist across reload, capped, cleared/namespaced on logout/user-switch (storage keys documented).
- [ ] Private records never surface (UI + storage + sources check).
- [ ] Debounced API (or local-only documented); offline degrades with notice.
- [ ] Perf with 5k <300ms virtualized; mobile sheet usable; dark + reduced-motion + SR/trap + axe pass.
- [ ] Evidence: shortcut captures per OS, keyboard matrix video, storage dumps, perf traces, mobile/dark screenshots.
- [ ] Defects filed with query strings, role, storage dump, and build hash.
