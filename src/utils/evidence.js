// src/utils/evidence.js
//
// Run evidence: a PNG per documented validation point, written to
// artifacts/evidence/<spec-basename>/<ordinal>-<slug>.png and attached to the
// Playwright HTML report and Allure.
//
// THESE ARE EVIDENCE ARTIFACTS, NOT VISUAL BASELINES.
// ---------------------------------------------------
// Nothing here compares images and nothing here should. A price rule's
// correctness is asserted against SBQQ__QuoteLine__c, never against what the
// screen rendered; these files exist so a human reviewing a badge submission can see
// the screen at the moment each assertion was made. Never reach for
// toHaveScreenshot() on this output — a pixel diff on a Lightning page fails
// on font rendering and tells you nothing about pricing.
//
// A CAPTURE FAILURE MUST NEVER FAIL A TEST.
// -----------------------------------------
// Every path through captureEvidence() is wrapped. A missing element, a
// detached frame, a full disk — all of them log and continue. The alternative
// is a suite whose pricing assertions are held hostage by its own bookkeeping,
// which inverts what matters.
const fs = require('fs');
const path = require('path');

// Repo-relative artifacts/evidence, resolved absolutely so a caller's cwd
// cannot move it. artifacts/ as a whole is gitignored.
const EVIDENCE_ROOT = path.join(__dirname, '..', '..', 'artifacts', 'evidence');

/**
 * The folder one spec's evidence lands in.
 *
 * Derived from the SPEC FILE BASENAME, never from the test title. A title is
 * prose and gets reworded; renaming one would orphan its old folder and leave
 * two half-populated directories that look like two runs.
 */
function folderFor(testInfo) {
  const base = path
    .basename(testInfo.file || 'unknown')
    .replace(/\.spec\.js$/, '')
    .replace(/[^a-z0-9._-]+/gi, '-');
  return path.join(EVIDENCE_ROOT, base);
}

/** Filesystem-safe, lowercase, no spaces — names are used verbatim as filenames. */
function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'capture';
}

/**
 * A Playwright Locator and a Page both expose screenshot(), so the two are
 * told apart by something only a Locator has. boundingBox() is that, and it is
 * also the thing this module needs from a Locator anyway.
 */
function isLocator(target) {
  return !!target && typeof target.boundingBox === 'function';
}

/**
 * Captures one evidence screenshot.
 *
 * Element-scoped when given a Locator, because a full-page shot of the Quote
 * Line Editor is mostly Lightning chrome and the price columns come out too
 * small to read. Falls back to the whole page when the element has no bounding
 * box (zero-size shadow host, scrolled-out frame) or when the element shot
 * throws for any other reason — evidence of the wrong scope beats no evidence.
 *
 * @param {import('@playwright/test').Locator|import('@playwright/test').Page} target
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} name  zero-padded ordinal + step slug, e.g. '03-netbook-list-price-400'.
 *        Deterministic on purpose: a rerun overwrites in place rather than
 *        accumulating near-duplicates nobody can tell apart.
 * @returns {Promise<string|null>} the file path written, or null if nothing was captured
 */
async function captureEvidence(target, testInfo, name) {
  const fileName = `${slugify(name)}.png`;
  let file;

  try {
    const dir = folderFor(testInfo);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, fileName);

    let buffer;
    if (isLocator(target)) {
      try {
        const box = await target.boundingBox();
        if (!box) throw new Error('element has no bounding box');
        buffer = await target.screenshot({ timeout: 15_000 });
      } catch (elementError) {
        // page() exists on a Locator and gives us the page it was built from,
        // so the fallback needs nothing from the caller.
        const page = typeof target.page === 'function' ? target.page() : null;
        if (!page) throw elementError;
        console.warn(
          `[evidence] ${fileName}: element capture failed (${elementError.message.split('\n')[0]}) ` +
            '— falling back to a full-page shot.'
        );
        buffer = await page.screenshot({ timeout: 15_000 });
      }
    } else {
      buffer = await target.screenshot({ timeout: 15_000 });
    }

    fs.writeFileSync(file, buffer);

    // Attached as well as written to disk, so the image reaches the HTML
    // report and Allure without anyone having to open artifacts/ by hand.
    await testInfo.attach(name, { body: buffer, contentType: 'image/png' });

    return file;
  } catch (e) {
    console.warn(
      `[evidence] could not capture "${name}"${file ? ` (${file})` : ''}: ${e.message.split('\n')[0]}`
    );
    return null;
  }
}

/**
 * Empties artifacts/evidence/ so a run's output is exactly that run's.
 *
 * Called ONCE per run, from global-setup.js, and guarded there by
 * CPQ_REUSE_SESSION — a child process spawned with that flag set must never
 * delete a sibling's output. Deleting is safe because the whole tree is
 * regenerated by the run that clears it; nothing here is ever the only copy.
 */
function clearEvidence() {
  try {
    fs.rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  } catch (e) {
    // Same reasoning as the ledger merge in global-teardown.js: bookkeeping
    // must never turn a green run red. A stale folder is a cosmetic problem.
    console.warn(`[evidence] could not clear ${EVIDENCE_ROOT}: ${e.message}`);
  }
}

module.exports = { captureEvidence, clearEvidence, EVIDENCE_ROOT };
