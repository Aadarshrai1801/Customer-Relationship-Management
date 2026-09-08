# Attachments & Files – Comprehensive Testing Guide

Base URLs: API `http://localhost:3001`, Web `http://localhost:3000`.

## 1. Overview

This guide covers File Attachments on CRM records: upload via drag-drop and picker, download, preview, delete, and quota enforcement (25MB per file, 10GB per org).
Scope includes Contact/Deal/Task attachments, multiple-file upload, progress/cancel, file-type handling, virus/size validation, thumbnails/previews (image/PDF), permissions, and storage usage display.
Out of scope is external drive integrations unless present; focus is native attachment store.
Key roles: users with record edit can upload/delete (or delete own only per policy); viewers read-only/download per policy.
Critical rules: reject >25MB per file client + server; enforce 10GB org cap with clear error; prevent executable abuse (`.exe` handling per policy – block or warn); files isolated per org/tenant.
Success criteria: drag-drop + picker both work, caps enforced both layers, previews safe, and downloads byte-identical.

## 2. Prerequisites & Test Data Setup

- Stack: Web `:3000`, API `:3001`, object storage (local/S3) running and writable; note storage backend in run notes.
- Users: admin, rep1 (uploader), rep2 (cross-user), viewer (read-only); tokens saved.
- Records: test deal `DEAL-ATT`, contact `CONTACT-ATT`, task `TASK-ATT` dedicated to attachment tests.
- Test files (prepare in `C:\Users\Aadarsh\AppData\Local\Temp\opencode\attach\`):
  - `small.png` (100KB image), `doc.pdf` (1MB), `sheet.csv` (50KB), `notes.txt` (1KB).
  - `exact25.bin` (25.00MB), `over25.bin` (25.01MB / 26MB), `empty.txt` (0 bytes).
  - `evil.exe` (dummy), `xss.svg` (with `<script>`), `unicode-名前.pdf`, `a,b"c.pdf` (special chars).
  - Large filler to approach org cap on staging (or mock quota via API/DB flag – document method).
- Browser: Chrome + Firefox; allow downloads; clear download folder.
- Quota baseline: `GET /api/storage/usage` (or org settings page) to record `usedBytes` before/after.
- Network: DevTools for progress/XHR; throttle for cancel test.
- Cleanup: delete QA files after run; verify `usedBytes` decreases (if immediate) or note eventual consistency.

## 3. Test Environment Matrix

| Dimension     | Variants                                                 |
| ------------- | -------------------------------------------------------- |
| Upload method | Drag-drop, File picker, Paste (if supported)             |
| Entity        | Deal, Contact, Task                                      |
| Browser       | Chrome 130+, Firefox 132+, Edge 130+                     |
| File type     | png/jpg, pdf, csv, txt, docx, exe, svg, zip              |
| Size          | 1KB, 1MB, 24MB, 25MB exact, 25MB+1B, 100MB               |
| Role          | Admin, Owner, Non-owner with access, Viewer, No-access   |
| Network       | Broadband, Slow 3G (progress/cancel), Offline mid-upload |
| Storage       | Local, S3-compatible (if configured)                     |

- Record file hashes (SHA256) to verify download integrity.
- Test both single and multi-file (5 files) batches.
- Verify dark-mode preview modal and 768px dropzone.

## 4. Detailed Step-by-Step Test Cases (at least 18 numbered TC cases)

### TC-01 – Drag-Drop Single Image

- **Objective:** Verify drag-drop upload works.
- **Preconditions:** Open `DEAL-ATT` → Files tab as rep1.
- **Steps:**
  1. Drag `small.png` onto dropzone.
  2. Verify highlight state + progress bar + success toast.
  3. Verify thumbnail appears with name/size/uploader/time.
  4. Reload; verify persists.
  5. Download and `sha256sum` compare.
- **Expected:** Byte-identical download; thumbnail correct.

### TC-02 – File Picker Multi-Upload

- **Objective:** Verify picker with multiple files.
- **Preconditions:** Same record.
- **Steps:**
  1. Click Browse/Attach → select `doc.pdf` + `sheet.csv` + `notes.txt`.
  2. Verify queued list with per-file progress.
  3. Verify all three appear; counts update.
  4. Reload; verify all persist.
- **Expected:** All succeed; independent progress.

### TC-03 – Exact 25MB Boundary

- **Objective:** Verify 25MB file accepted.
- **Preconditions:** `exact25.bin` exactly 25*1024*1024 bytes.
- **Steps:**
  1. Verify size via `ls -l`.
  2. Upload via picker.
  3. Verify success (allow longer time).
  4. Verify `usedBytes` increased by ~25MB.
- **Expected:** Accepted; stored fully.

### TC-04 – Over 25MB Rejected (Client + Server)

- **Objective:** Verify >25MB rejected with clear error before and after upload.
- **Preconditions:** `over25.bin` (26MB).
- **Steps:**
  1. Attempt drag-drop; verify immediate client error `Max 25MB per file` without network upload (or abort quickly).
  2. Bypass client (curl) to prove server also rejects → expect 413/400.
  3. Verify no partial file listed and quota unchanged.
- **Expected:** Both layers reject; no orphan bytes counted.

### TC-05 – Zero-Byte File Handling

- **Objective:** Verify empty file policy.
- **Preconditions:** `empty.txt`.
- **Steps:**
  1. Upload `empty.txt`.
  2. Verify either accepted (0B row) or rejected with `File is empty` – document spec.
  3. If accepted, download and verify 0 bytes.
- **Expected:** Deterministic per spec, not crash.

### TC-06 – Blocked / Risky Types (.exe, .svg XSS)

- **Objective:** Verify executable and script-SVG handling.
- **Preconditions:** `evil.exe`, `xss.svg`.
- **Steps:**
  1. Upload `.exe`; verify blocked (`File type not allowed`) or allowed with warning per policy – record.
  2. Upload `xss.svg`; verify preview does NOT execute script.
  3. Inspect preview sandbox (`Content-Security-Policy`, `sandbox` iframe, `Content-Disposition: attachment` for svg).
- **Expected:** No script execution; policy documented.

### TC-07 – Special Characters & Unicode Names

- **Objective:** Verify filename encoding round-trips.
- **Preconditions:** `unicode-名前.pdf`, `a,b"c.pdf`.
- **Steps:**
  1. Upload both.
  2. Verify list shows full names.
  3. Download; verify names preserved (or sanitized deterministically).
  4. Verify API `originalName` vs `storedKey` fields.
- **Expected:** No truncation/mojibake; download name correct.

### TC-08 – Preview Image & PDF

- **Objective:** Verify in-app preview.
- **Preconditions:** `small.png` + `doc.pdf` uploaded.
- **Steps:**
  1. Click image; verify lightbox with zoom/close, Esc closes.
  2. Click PDF; verify viewer (pages render, pagination).
  3. Verify non-previewable (csv/exe) shows `No preview – Download` instead of crash.
- **Expected:** Previews render; fallback graceful.

### TC-09 – Download Integrity

- **Objective:** Verify downloads byte-identical.
- **Preconditions:** Uploaded set from TC-01/02.
- **Steps:**
  1. Download each; compute SHA256 vs original.
  2. Verify `Content-Type` and `Content-Disposition: attachment; filename=...`.
  3. Test download via API with token and without → 401 without.
- **Expected:** Hashes match; auth enforced.

### TC-10 – Delete File (Owner vs Others)

- **Objective:** Verify delete permissions.
- **Preconditions:** rep1 file on shared record.
- **Steps:**
  1. As rep1 delete own file → confirm modal → verify gone + quota decreases.
  2. Upload again; as rep2 (non-owner) attempt delete → expect hidden button or 403 per policy.
  3. As admin verify can delete any (if policy).
  4. Reload; verify state persists.
- **Expected:** Policy enforced UI + API.

### TC-11 – Org 10GB Cap Enforcement

- **Objective:** Verify org quota blocks when full.
- **Preconditions:** Staging org near cap (fill or mock `usedBytes=10GB-5MB`).
- **Steps:**
  1. Check usage display shows `9.99GB / 10GB`.
  2. Upload 10MB file → expect `Organization storage full (10GB)` error.
  3. Upload 1MB file → may succeed if under cap; verify math.
  4. Delete 100MB; verify new upload now succeeds.
- **Expected:** Clear cap error; usage bar accurate. Document mock method.

### TC-12 – Storage Usage Display

- **Objective:** Verify usage meter accuracy.
- **Preconditions:** Known baseline `usedBytes`.
- **Steps:**
  1. Note baseline from settings/API.
  2. Upload 1MB + 2MB; verify meter +3MB (allow metadata overhead note).
  3. Delete 1MB; verify −1MB.
  4. Refresh; verify persists.
- **Expected:** Meter tracks within bytes; no drift.

### TC-13 – Cancel / Offline Mid-Upload

- **Objective:** Verify cancel and network failure handling.
- **Preconditions:** Throttle to Slow 3G; large file (20MB).
- **Steps:**
  1. Start upload; click Cancel; verify row shows `Cancelled`, no ghost file, quota unchanged.
  2. Restart; disable network mid-upload; verify `Failed – retry` with Retry button.
  3. Re-enable; click Retry; verify success.
- **Expected:** No partial artifacts; retry works.

### TC-14 – Concurrent Uploads

- **Objective:** Verify 5 parallel uploads all succeed.
- **Preconditions:** 5 small files.
- **Steps:**
  1. Select all 5 at once.
  2. Verify 5 progress bars independent.
  3. Verify all complete; no lost file.
  4. Verify API lists 5 new IDs.
- **Expected:** All succeed; order stable.

### TC-15 – Attachments on Contact & Task Parity

- **Objective:** Verify all entities support same flow.
- **Preconditions:** `CONTACT-ATT`, `TASK-ATT`.
- **Steps:**
  1. Upload `notes.txt` to contact; verify.
  2. Upload `notes.txt` to task; verify.
  3. Delete from task; verify contact copy unaffected (separate scoping).
- **Expected:** Parity; scoping per record.

### TC-16 – Permissions: No-Access Cannot List/Download

- **Objective:** Verify tenant/record isolation.
- **Preconditions:** Private deal (rep1 only).
- **Steps:**
  1. As rep2 `GET /api/deals/PRIVATE_ID/attachments` → expect 403/404.
  2. Attempt direct file URL without token → 401; with rep2 token → 403.
  3. UI: rep2 opening private deal URL sees no-access, not file list.
- **Expected:** No leakage via list or direct URL.

### TC-17 – Virus / Integrity Note (if scanner present)

- **Objective:** Document scanner behavior or absence.
- **Preconditions:** EICAR test string file (if allowed in env).
- **Steps:**
  1. Upload EICAR file if policy permits test.
  2. Verify quarantined/blocked or pass-through per spec.
  3. If no scanner, verify upload succeeds and record `No AV – N/A`.
- **Expected:** Documented outcome; no crash.

### TC-18 – Responsive & Accessibility

- **Objective:** Verify dropzone usable on small screens + keyboard.
- **Preconditions:** 768px viewport, keyboard only.
- **Steps:**
  1. Tab to Attach button; Enter opens picker.
  2. Verify dropzone label announced; progress `aria-live`.
  3. At 768px verify list wraps, preview modal fits.
- **Expected:** Keyboard path complete; axe clean.

### TC-19 – API Validation Negatives

- **Objective:** Verify API rejects bad uploads.
- **Preconditions:** Valid token.
- **Steps:**
  1. POST without file → 400.
  2. POST without token → 401.
  3. POST to invalid record ID → 404.
  4. GET file with wrong org token → 403.
- **Expected:** Correct 4xx; no 500; no partial write.

## 5. API Testing Section

| Method & Endpoint                                          | Purpose          | Auth           | Notes                             |
| ---------------------------------------------------------- | ---------------- | -------------- | --------------------------------- |
| `GET /api/deals/:id/attachments` (same for contacts/tasks) | List files       | Bearer         | `id,name,size,mime,url,createdAt` |
| `POST /api/deals/:id/attachments`                          | Upload multipart | Bearer         | Field `file`; 25MB cap → 413      |
| `GET /api/attachments/:fileId/download`                    | Download bytes   | Bearer         | Check headers + hash              |
| `DELETE /api/attachments/:fileId`                          | Delete           | Bearer         | Quota decreases                   |
| `GET /api/storage/usage` or `/api/org/storage`             | Quota meter      | Bearer (admin) | `usedBytes, capBytes=10GB`        |

```bash
# 1) Login
curl -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"rep1@test.com","password":"Rep123!"}'
# -> $REP1_TOKEN

# 2) List
curl -s http://localhost:3001/api/deals/DEAL_ID/attachments \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool

# 3) Upload small file
curl -s -X POST http://localhost:3001/api/deals/DEAL_ID/attachments \
  -H "Authorization: Bearer $REP1_TOKEN" -F "file=@/tmp/small.png" | python3 -m json.tool

# 4) Over-cap file should 413 (26MB)
curl -i -X POST http://localhost:3001/api/deals/DEAL_ID/attachments \
  -H "Authorization: Bearer $REP1_TOKEN" -F "file=@/tmp/over25.bin" | head -n 20

# 5) Download + hash check
curl -s http://localhost:3001/api/attachments/FILE_ID/download \
  -H "Authorization: Bearer $REP1_TOKEN" -o /tmp/dl.png
sha256sum /tmp/small.png /tmp/dl.png

# 6) Quota
curl -s http://localhost:3001/api/storage/usage \
  -H "Authorization: Bearer $REP1_TOKEN" | python3 -m json.tool
```

- Adapt paths if implementation uses `/api/attachments?entity=deal&entityId=X`; document actual.
- Assert: upload returns `size` matching `ls -l`; download hash equal; quota delta equals size; 413 for over-limit; 401 anon.

## 6. UI Testing Section

- Dropzone: dashed border, `Drag files here or Browse`, highlight on dragover, accepts multi-select; disabled state during upload with per-file progress + % + Cancel.
- List: icon by type, name (truncated with tooltip), size humanized (`25.0 MB`), uploader + relative time, Preview/Download/Delete actions.
- Preview modal: image zoom, PDF pager, keyboard Esc/←/→, download-from-preview, safe fallback for others.
- Errors: inline per-file (`Too large – max 25MB`, `Storage full`, `Type blocked`) + toast summary; quota bar turns red near 100%.
- Empty: `No files yet – drag files here` illustration.
- Responsive: 768px list stacks; modal fits; drag-drop degrades to picker on touch.
- A11y: dropzone `role=button` + label, progress `aria-valuenow`, focus returns to list after modal close.

## 7. Regression & Cross-Feature Impact

- Permissions: record sharing revoke must immediately block file list/download.
- Quota: imports with files, email attachments (if any) must count same; admin billing/upgrade does not change 10GB unless plan-based (document).
- Search: filenames searchable (or not) – verify expectation.
- Audit: upload/delete logged with actor + bytes.
- Workflows: `file attached` trigger (if any) fires; check log.
- Deletion: record delete cascades or blocks with `has files` warning per spec.
- Performance: 25MB upload must not block UI; list with 100 files paginates/virtualizes.

## 8. Expected Results Summary Table

| TC    | Title             | Expected               | Severity |
| ----- | ----------------- | ---------------------- | -------- |
| TC-01 | Drag-drop image   | Success + hash match   | Critical |
| TC-02 | Picker multi      | All persist            | Major    |
| TC-03 | Exact 25MB        | Accepted               | Major    |
| TC-04 | Over 25MB         | Client+server reject   | Critical |
| TC-05 | Zero-byte         | Per-spec deterministic | Minor    |
| TC-06 | exe/svg           | Blocked/sandboxed      | Critical |
| TC-07 | Unicode names     | Round-trip             | Minor    |
| TC-08 | Preview           | Image/PDF OK, fallback | Major    |
| TC-09 | Download hash     | Identical + auth       | Critical |
| TC-10 | Delete perms      | Policy enforced        | Major    |
| TC-11 | 10GB cap          | Clear error            | Critical |
| TC-12 | Usage meter       | Accurate               | Major    |
| TC-13 | Cancel/offline    | Retry, no ghost        | Major    |
| TC-14 | Concurrent 5      | All succeed            | Minor    |
| TC-15 | Entity parity     | Same flow              | Major    |
| TC-16 | No-access blocked | 403/401                | Critical |
| TC-17 | AV note           | Documented             | Minor    |
| TC-18 | Responsive/a11y   | Keyboard OK            | Minor    |
| TC-19 | API negatives     | 4xx                    | Major    |

## 9. Troubleshooting & Common Failures

| Symptom                 | Cause                                              | Fix                                                                 |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Upload stalls at 100%   | Server processing (AV/thumbnail) slow              | Wait; check server logs; verify final row appears                   |
| 413 but file <25MB      | Reverse-proxy limit (nginx `client_max_body_size`) | Raise proxy limit to 30MB+; retest                                  |
| Downloaded file corrupt | Truncated stream / wrong range                     | Compare `Content-Length` vs `ls -l`; retry; check storage backend   |
| Preview blank PDF       | Worker/CORS missing                                | Check console; verify `Content-Type: application/pdf`               |
| Quota not decreasing    | Eventual consistency / soft-delete retention       | Wait + refresh; check trash/retention policy                        |
| SVG executes            | Missing sandbox/CSP                                | File critical sec bug; serve with `Content-Disposition: attachment` |
| Filename mojibake       | Missing UTF-8 `filename*=`                         | Inspect `Content-Disposition` header; fix encoding                  |

- Debug: Network `attachments` XHR status + timing; `sha256sum` both ends; `GET /storage/usage` before/after; server storage logs.
- Reset: delete QA files; verify quota returns; clear multipart temp dir if stuck.

## 10. Pass/Fail Checklist

- [ ] Drag-drop + picker + multi-upload verified with hash-identical downloads.
- [ ] Exact 25MB accepted; 25MB+ rejected client + server (413) with no quota change.
- [ ] Risky types handled; SVG preview sandboxed, no script execution.
- [ ] Unicode/special names round-trip; previews + fallbacks correct.
- [ ] Delete permissions enforced; quota meter accurate; 10GB cap blocks clearly.
- [ ] Cancel/offline/concurrent behaviors correct with no ghosts.
- [ ] No-access isolation via list + direct URL (401/403).
- [ ] Responsive + keyboard + axe checks pass.
- [ ] API curls behave; negatives return proper 4xx.
- [ ] Evidence: file list screenshots, quota captures, hash logs, header dumps.
- [ ] Defects filed with file names, sizes, hashes, record IDs.
