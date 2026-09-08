# App Shell & Theming – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers App Shell: collapsible sidebar, breadcrumbs, dark-mode parity, skeleton/empty states, toasts/modals, responsive behavior, and WCAG 2.1 AA compliance.
Shell frames every feature – regressions here break all pages – so this is a cross-cutting gate.
Scope includes sidebar expand/collapse + persistence, nav active states, breadcrumbs with deep-link/back, theme toggle (light/dark/system) with persistence, skeleton loaders, empty illustrations + CTAs, toast stacking/dismiss/undo, modal focus-trap/Esc, responsive breakpoints (1440/1280/768/375), print (best-effort), and axe + keyboard + contrast checks.
Out of scope is feature logic (covered per-guide), but shell integration points (e.g., report tables inside shell) are checked.
Key roles: all roles share shell; admin sees extra nav (Billing, Workflows, Webhooks); viewer sees reduced nav.
Critical rules: sidebar state persists per user; dark mode has zero light-only hardcoded surfaces; every async view shows skeleton → content/empty/error (never blank); toasts announce via live-region; modals trap focus; contrast ≥4.5:1 text.
Success criteria: shell usable keyboard-only, axe 0 critical/serious, responsive without horizontal page scroll, and theme parity screenshots approved.

## 2. Prerequisites & Test Data Setup

- App Web `:3000` + API `:3001` running; seed minimal (1 deal/contact/task) to contrast empty vs populated states (use fresh user for empties).
- Users: admin (full nav), rep (standard), viewer (reduced); tokens if API spot-checks needed.
- Browsers: Chrome + Firefox + Edge/Safari if available; viewport presets 1440/1280/768/375; DevTools (Rendering → emulate `prefers-color-scheme`, `prefers-reduced-motion`).
- Tools: axe DevTools extension (or `npx axe` / Lighthouse), colour-contrast analyser, keyboard only (unplug mouse for a pass).
- Baseline: sidebar expanded default; theme `system` or `light` default – record; localStorage keys (e.g., `crm.theme`, `crm.sidebar` – document actuals).
- Cleanup: restore theme expanded/light after run; clear test toasts.

## 3. Test Environment Matrix

| Dimension     | Variants                                                           |
| ------------- | ------------------------------------------------------------------ |
| Browser       | Chrome 130+, Firefox 132+, Edge 130+, Safari 17+                   |
| Viewport      | 1440px, 1280px, 768px tablet, 375px mobile                         |
| Role/nav      | Admin full, Rep standard, Viewer reduced, Logged-out (login shell) |
| Theme         | Light, Dark, System (follow OS both)                               |
| Motion        | Full, `prefers-reduced-motion: reduce`                             |
| State         | Loading (throttled), Empty (fresh), Error (500 block), Populated   |
| Shell control | Sidebar, Breadcrumb, Toast, Modal, Skeleton                        |
| Page host     | Home, Deals, Reports, Settings (shell consistent)                  |

- Record: OS/browser/viewport/theme/role per screenshot; axe version + rule set.
- Test both cold load and in-app navigation (sidebar vs back-button).

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Sidebar Expand/Collapse Persists Per User

- **Objective:** Verify toggle + memory.
- **Preconditions:** Desktop 1440px, logged in rep1 expanded.
- **Steps:**
  1. Click collapse (chevron/hamburger); verify icons-only rail with tooltips, content widens.
  2. Reload; verify stays collapsed.
  3. Expand; reload; verify expanded.
  4. Login as rep2; verify independent state (or global – document).
  5. Inspect `localStorage` key (e.g., `crm.sidebar=collapsed`) – document actual.
- **Expected:** Persists; tooltips on rail; no content jump that loses click.

### TC-02 – Sidebar Active States + Badges

- **Objective:** Verify nav highlights current + counts.
- **Preconditions:** Deals + Tasks with due counts.
- **Steps:**
  1. Go Deals; verify Deals highlighted (`aria-current=page`).
  2. Go Reports → Forecast tab; verify Reports highlighted (parent).
  3. Verify task badge (e.g., `3 due`) matches Focus count.
  4. Collapse; verify active still indicated (accent bar).
- **Expected:** Accurate highlight; badges reconcile.

### TC-03 – Sidebar Role Filtering (Admin vs Viewer)

- **Objective:** Verify nav least-privilege.
- **Preconditions:** Admin + viewer logins.
- **Steps:**
  1. As admin verify Billing, Workflows, Webhooks visible.
  2. As viewer verify those hidden (or disabled with lock tooltip – document).
  3. Direct URL as viewer to `/settings/billing` → 403 page inside shell (not blank).
- **Expected:** Hidden/gated + 403 shell page.

### TC-04 – Breadcrumbs Deep-Link + Back

- **Objective:** Verify trail navigates.
- **Preconditions:** Deal detail `DEAL-01`.
- **Steps:**
  1. Verify `Home / Deals / Acme – $5k` trail.
  2. Click `Deals`; verify list with prior filters (or defaults – document).
  3. Browser Back; verify returns to detail (not Home).
  4. Copy breadcrumb URL; open new tab; verify lands same.
- **Expected:** Clickable; back sane; shareable.

### TC-05 – Breadcrumb Overflow (Long Names, Mobile)

- **Objective:** Verify truncation graceful.
- **Preconditions:** Deal name 120 chars; 375px.
- **Steps:**
  1. Open long-name detail desktop; verify middle-truncate with full title tooltip.
  2. 375px: verify breadcrumb collapses to `‹ Deals` back affordance.
- **Expected:** No wrap-breakage; tooltip full.

### TC-06 – Dark-Mode Toggle + System Follow

- **Objective:** Verify three-way theme.
- **Preconditions:** OS light; app light.
- **Steps:**
  1. Toggle Dark; verify instant swap (<200ms), persists reload, `localStorage crm.theme=dark`.
  2. Set System; change OS to dark (DevTools Rendering); verify follows without reload (or after reload – document).
  3. Toggle back Light.
- **Expected:** All three work; persisted.

### TC-07 – Dark-Mode Parity Sweep (All Components)

- **Objective:** Verify zero light-only surfaces.
- **Preconditions:** Dark on; visit Home, Deals table, Reports charts, Settings, modals, toasts, skeletons, empty pages.
- **Steps:**
  1. Screenshot each; verify backgrounds/text/borders/charts/inputs legible, no white flash boxes.
  2. Check chart legend/tooltip, code/JSON viewers, calendar pickers.
  3. Log any `#fff` hardcode found via inspector.
- **Expected:** Approved parity set; issues filed with selectors.

### TC-08 – Contrast ≥4.5:1 (Text) / 3:1 (Large/UI)

- **Objective:** Verify WCAG AA contrast both themes.
- **Preconditions:** Light + dark.
- **Steps:**
  1. Sample: body text, secondary (`…ago`), placeholder, disabled, links, error red, success green, focus ring, chart labels.
  2. Measure with analyser; record ratios.
  3. Fix-or-file any <4.5 (text) / <3.0 (large/UI).
- **Expected:** Pass table; no critical low-contrast CTA.

### TC-09 – Skeleton Loaders (Throttled) Per View

- **Objective:** Verify perceived loading, no blank.
- **Preconditions:** Fast 3G throttle; clear cache.
- **Steps:**
  1. Hard-load Home, Deals, Reports; verify shimmer skeletons matching layout instantly.
  2. Verify skeletons aria-hidden + `Loading…` live text (not silent).
  3. Verify content replaces (no skeleton stuck >15s).
- **Expected:** Immediate feedback; resolves.

### TC-10 – Empty States with CTA (Fresh User)

- **Objective:** Verify guided empties.
- **Preconditions:** Fresh user 0 records.
- **Steps:**
  1. Deals/Contacts/Tasks/Files each show illustration + `No … yet` + `Create` CTA.
  2. Click CTA; verify correct modal.
  3. Verify empty search (`zzzz`) differs from empty collection (`Clear search` vs `Create`).
- **Expected:** Two empty flavors correct.

### TC-11 – Error States with Retry (Forced 500/Offline)

- **Objective:** Verify failures show Retry, not blank.
- **Preconditions:** Block `GET /api/deals` (proxy/offline).
- **Steps:**
  1. Open Deals; verify `Couldn't load deals – Retry` card inside shell (sidebar intact).
  2. Click Retry online; verify recovers.
  3. Verify error logged (console) but not raw stack to user.
- **Expected:** Shell survives; retry works.

### TC-12 – Toasts: Stack, Dismiss, Undo, Live-Region

- **Objective:** Verify toast contract.
- **Preconditions:** Trigger 3 rapid saves.
- **Steps:**
  1. Verify max stack 3, newest top, auto-dismiss 5s, pause on hover.
  2. Verify × dismisses; Undo (where present) works within window.
  3. Verify `role=status aria-live=polite` announces (screen-reader or inspector).
  4. Verify toasts above modal/sidebar (z-index) and not clipped mobile.
- **Expected:** Stacked, announced, actionable.

### TC-13 – Modals: Focus Trap, Esc, Backdrop, Return Focus

- **Objective:** Verify dialog a11y.
- **Preconditions:** New Deal modal open from Deals (trigger focused).
- **Steps:**
  1. Verify focus moves to first field; Tab cycles inside only.
  2. `Esc` closes + focus returns to trigger.
  3. Backdrop click closes only if non-destructive (dirty form asks `Discard?` – document).
  4. Verify `role=dialog aria-modal=true aria-labelledby`.
- **Expected:** Trapped, labelled, returns focus.

### TC-14 – Responsive 768px: Sidebar Becomes Drawer

- **Objective:** Verify tablet nav pattern.
- **Preconditions:** 768px.
- **Steps:**
  1. Verify sidebar hidden behind hamburger; tap opens overlay drawer with scrim.
  2. Select destination; verify drawer closes + navigates.
  3. Verify content full-width, tables scroll internally.
- **Expected:** Drawer usable; no page h-scroll.

### TC-15 – Responsive 375px: Header + Bottom Reach

- **Objective:** Verify phone usable one-handed.
- **Preconditions:** 375px.
- **Steps:**
  1. Verify header condenses (logo + search icon + avatar + hamburger), breadcrumbs collapse.
  2. Verify primary CTAs reachable (sticky action bar if present).
  3. Verify tables → cards or horizontal scroll with sticky first col (document pattern).
- **Expected:** No overlap; CTAs reachable.

### TC-16 – Keyboard-Only Full Tour (No Mouse)

- **Objective:** Verify operable without pointer.
- **Preconditions:** Unplug mouse; fresh focus at Skip-link.
- **Steps:**
  1. `Tab` from Skip to content → sidebar nav → main → header; verify visible focus everywhere.
  2. Open palette (`Ctrl+K`), navigate, open modal, submit via keyboard.
  3. Verify no trap (except modal intentional) and all toasts announced.
- **Expected:** Complete tour; focus always visible.

### TC-17 – Axe Audit 0 Critical/Serious (Light + Dark)

- **Objective:** Verify automated a11y gate.
- **Preconditions:** axe DevTools; Home + Deals + modal open.
- **Steps:**
  1. Run axe on Home light; record violations.
  2. Repeat dark + with modal open.
  3. Verify 0 critical/serious; minors triaged (colour, landmark, heading order).
- **Expected:** Gate passes; report attached.

### TC-18 – Reduced Motion Respected

- **Objective:** Verify `prefers-reduced-motion` disables animation.
- **Preconditions:** Emulate reduce.
- **Steps:**
  1. Toggle sidebar/theme; verify instant (no slide/fade).
  2. Trigger toast/skeleton; verify static (no shimmer slide).
  3. Open palette/modal; verify no scale.
- **Expected:** Instant; no vestibular triggers.

### TC-19 – Print / Zoom 200% (Best-Effort)

- **Objective:** Verify zoom + print sane.
- **Preconditions:** Deals list populated.
- **Steps:**
  1. Zoom 200%; verify no clipped CTAs, page scrolls vertically only (no 2D scroll trap).
  2. Print preview; verify sidebar hidden, table prints (or `Use CSV for full` note – document).
- **Expected:** Usable at 200%; print not blank.

## 5. API Testing Section

Shell is frontend, but spot-check backing prefs + health (at least 4 examples; UI + storage primary).

| Method & Endpoint                    | Purpose                                  | Auth   | Notes                          |
| ------------------------------------ | ---------------------------------------- | ------ | ------------------------------ |
| `GET /api/health`                    | Shell can render degraded banner if down | None   | Pre-check                      |
| `GET /api/me`                        | Display name/avatar + TZ driving shell   | Bearer | Greeting/avatar                |
| `GET /api/notifications?unread=true` | Bell badge in header                     | Bearer | Count = badge                  |
| `GET /api/deals?limit=1`             | Skeleton→content probe                   | Bearer | 500-block for error-state test |

```bash
# 1) Health (shell banner probe)
curl -s http://localhost:3001/api/health | python3 -m json.tool

# 2) Me (shell identity)
curl -s http://localhost:3001/api/me -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool

# 3) Badge count (header bell)
curl -s "http://localhost:3001/api/notifications?unread=true&limit=1" \
  -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool

# 4) Force list for skeleton/error contrast (compare fast vs blocked)
curl -s "http://localhost:3001/api/deals?limit=1" -H "Authorization: Bearer $REP_TOKEN" | python3 -m json.tool
curl -i "http://localhost:3001/api/deals?limit=1" | head -n 5  # expect 401 anon -> shell shows login, not blank
```

- Primary shell asserts are UI: `localStorage` theme/sidebar keys, `aria-current`, `role=dialog`, axe JSON.
- Document ACTUAL storage keys found:

```js
// DevTools on http://localhost:3000
Object.keys(localStorage).filter(
  (k) => k.includes('theme') || k.includes('sidebar') || k.includes('crm'),
);
localStorage.getItem('crm.theme');
localStorage.getItem('crm.sidebar');
```

## 6. UI Testing Section

- Sidebar: 240px expanded / 64px rail, section headers ( CRM, Manage), icons + labels, collapse chevron, tooltips on rail, badge pills, footer user card.
- Header: breadcrumb (desktop) / back (mobile), global search trigger, theme toggle, bell with badge, avatar menu (Profile, Preferences, Logout).
- Theme: CSS vars (`--bg`, `--text`) flip; images/logos swap (dark logo); charts use theme tokens; no FOUC (pre-paint script sets class).
- Skeletons: card/row/chart variants; shimmer (disabled reduced-motion); `aria-busy=true` on containers.
- Empty/error: centered illustration (160px), title + hint + primary CTA + secondary (`Import`/`Learn more`); error adds `Retry` + `Details` (collapsed).
- Toasts/modals: bottom-right stack (desktop) / top (mobile); modal 480px centered, 100% sheet mobile; scrim `rgba(0,0,0,.5)`.
- Motion: 150ms ease for sidebar/theme/modal; skeleton shimmer 1.2s linear infinite (static when reduced).

## 7. Regression & Cross-Feature Impact

- Every page inherits shell – sidebar/breadcrumb/theme bugs multiply; gate releases on this file.
- Nav: new routes must add sidebar entry + breadcrumb + palette `Go to` + RBAC in one PR (checklist).
- Theme: new components must use tokens, never hardcoded `#fff/#000` (lint rule – verify).
- Toasts/modals: feature toasts must use shared system (consistent timing/live-region).
- Bell/avatar: notification count + profile changes propagate to shell without reload (or documented refresh).
- Offline: shell shows offline banner; queued writes (inline edits) still offer retry.

## 8. Expected Results Summary Table

| TC    | Title           | Expected           | Severity |
| ----- | --------------- | ------------------ | -------- |
| TC-01 | Sidebar persist | Per-user memory    | Major    |
| TC-02 | Active+badges   | Accurate           | Minor    |
| TC-03 | Role nav        | Hidden + 403 shell | Major    |
| TC-04 | Breadcrumbs     | Clickable + back   | Major    |
| TC-05 | Crumb overflow  | Truncate + back    | Minor    |
| TC-06 | Theme 3-way     | Persist + follow   | Major    |
| TC-07 | Dark sweep      | No light-only      | Major    |
| TC-08 | Contrast AA     | ≥4.5/3.0           | Major    |
| TC-09 | Skeletons       | Instant + resolve  | Major    |
| TC-10 | Empties + CTA   | Two flavors        | Major    |
| TC-11 | Errors + Retry  | Shell survives     | Major    |
| TC-12 | Toasts          | Stack + announce   | Major    |
| TC-13 | Modals trap     | Labelled + return  | Critical |
| TC-14 | 768 drawer      | Overlay usable     | Major    |
| TC-15 | 375 header      | Reachable          | Minor    |
| TC-16 | Keyboard tour   | Complete, visible  | Critical |
| TC-17 | Axe 0 crit      | Gate passes        | Critical |
| TC-18 | Reduced motion  | Instant            | Minor    |
| TC-19 | Zoom/print      | Usable             | Minor    |

## 9. Troubleshooting & Common Failures

| Symptom                      | Cause                                              | Fix                                                                |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Sidebar resets each reload   | Persist writes to session not local / key mismatch | Check `localStorage` write on toggle; unify key per user           |
| Dark flashes white (FOUC)    | Theme applied after paint                          | Inline pre-paint script reading `crm.theme`; file perf/a11y bug    |
| Chart invisible dark         | Hardcoded light axis color                         | Use theme tokens; retest sweep                                     |
| Toast behind modal           | z-index order                                      | Stack: modal 1000, toast 1300, palette 1400 – document scale       |
| Focus lost after modal       | No return-focus                                    | Store trigger ref; focus on unmount                                |
| Axe `landmark` fail          | Missing `<main>/<nav>`                             | Add roles; ensure single h1 per view                               |
| Contrast fail secondary text | `#999` on white                                    | Darken to `#595959`+ (light) / `#B0B0B0`+ (dark)                   |
| H-scroll at 768px            | Table min-width + shell padding                    | Internal scroll container; `overflow-x:auto` on table wrapper only |

- Debug: Rendering emulation, axe JSON export, contrast readings, `localStorage` dumps, focus (`document.activeElement`) log.
- Reset: `localStorage.removeItem('crm.theme'/'crm.sidebar')` (actual keys) + reload.

## 10. Pass/Fail Checklist

- [ ] Sidebar collapses/persists, actives/badges correct, roles filtered with 403 shell.
- [ ] Breadcrumbs navigate + back + share; overflow + mobile back verified.
- [ ] Theme light/dark/system persists + follows; parity sweep screenshots approved.
- [ ] Contrast table AA; skeletons instant; empties (2 flavors) + errors with Retry.
- [ ] Toasts stack/announce/undo; modals trap/label/return-focus.
- [ ] Responsive drawer (768) + condensed header (375) with no page h-scroll.
- [ ] Keyboard-only tour complete with visible focus; axe 0 critical/serious light+dark+modal.
- [ ] Reduced-motion instant; zoom 200% usable; print not blank (or documented CSV note).
- [ ] Spot-check APIs (health/me/badge) + storage keys documented; evidence (axe reports, contrast table, screenshots per theme/viewport) attached.
- [ ] Defects filed with viewport/theme/role/selector + video where motion-related.
