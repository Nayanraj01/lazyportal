import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the actual views with fixture caches; effects do not run, so no portal
// requests are made. This also checks the first frame between chained reads.
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const session = { username: "test-student", instituteid: "test-campus", token: "test-token" };
const semester = { registrationid: "sem1", registrationcode: "2026ODDSEM" };
let server, MarksSection, ExamsSection, AttendancePage, SubjectDetailSheet, sessionCacheKey, client, fetchAutosolvedCaptcha;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });
  ({ MarksSection } = await server.ssrLoadModule("/src/sections/marks.tsx"));
  ({ ExamsSection } = await server.ssrLoadModule("/src/sections/exams.tsx"));
  ({ AttendancePage } = await server.ssrLoadModule("/src/pages/AttendancePage.tsx"));
  ({ SubjectDetailSheet } = await server.ssrLoadModule("/src/components/SubjectDetailSheet.tsx"));
  ({ sessionCacheKey } = await server.ssrLoadModule("/src/hooks/useFeature.ts"));
  ({ client } = await server.ssrLoadModule("/src/lib/portal.ts"));
  ({ fetchAutosolvedCaptcha } = await server.ssrLoadModule("/src/lib/captchaSolve.ts"));
});
after(async () => { await server?.close(); });
beforeEach(() => values.clear());

function cache(feature, data, ...parts) {
  const key = sessionCacheKey(feature, session, ...parts);
  values.set(`juet.cache.${key}`, JSON.stringify({ data, updatedAt: Date.now() }));
}
function selectSemester(feature) {
  values.set(`juet.portal.sem.${sessionCacheKey("semester", session, feature)}`, "sem1");
}
function render(Component) {
  return renderToStaticMarkup(createElement(Component, { session, onBack() {}, onLogout() {} }));
}

test("marks opening and semester-selection gaps show loading rather than No marks", () => {
  values.set("juet.portal.card.marks", "1");
  for (const seeded of [false, true]) {
    if (seeded) cache("marks.latest", { semesters: [semester], rows: [] });
    const html = render(MarksSection);
    assert.match(html, /Loading…/);
    assert.doesNotMatch(html, /No marks/);
  }
  selectSemester("marks");
  assert.match(render(MarksSection), /No marks records found/);
});

test("exams stay loading through the semester/events/schedule chain", () => {
  values.set("juet.portal.card.exams", "1");
  for (const stage of [0, 1, 2, 3]) {
    if (stage === 1) cache("exams.sems", [semester]);
    if (stage === 2) selectSemester("exams");
    if (stage === 3) cache("exams.events", [{ exameventid: "event1" }], "sem1");
    const html = render(ExamsSection);
    assert.match(html, /Loading…/);
    assert.doesNotMatch(html, /No schedules|No exam schedule published/);
  }
  cache("exams.rows", [], "sem1", "event1");
  assert.match(render(ExamsSection), /No exam schedule published/);
});

test("all-past schedules are collapsed and no longer counted as scheduled", () => {
  values.set("juet.portal.card.exams", "1");
  selectSemester("exams");
  cache("exams.sems", [semester]);
  cache("exams.events", [{ exameventid: "event1" }], "sem1");
  cache("exams.rows", [{ datetime: "01/01/2000", datetimeupto: "09:00 am to 11:00 am", subjectdesc: "PAST EXAM" }], "sem1", "event1");
  const html = render(ExamsSection);
  assert.match(html, /No upcoming exams/);
  assert.match(html, /<details class="past-exams"><summary>Past exams \(1\)<\/summary>/);
  assert.doesNotMatch(html, /1 scheduled/);
});

test("attendance displays overview percentages before class logs arrive", () => {
  selectSemester("attendance");
  cache("att.initial", { semesters: [semester], rows: [{
    subjectid: "subject1", subjectcode: "TEST SUBJECT(CS101)",
    Psubjectcomponentid: "p1", Ppercentage: 83.3,
  }] });
  const html = render(AttendancePage);
  assert.match(html, /83\.3%<\/span>/);
  assert.doesNotMatch(html, /No classes yet/);
  // An empty log response still must not contradict a known overview percent.
  cache("att.subject", { P: { student_attdsummarylist: [] } }, "sem1", "subject1");
  assert.doesNotMatch(render(AttendancePage), /No classes yet/);
});

test("attendance keeps cached counts and percentages on returning to the page", () => {
  selectSemester("attendance");
  cache("att.initial", { semesters: [semester], rows: [{
    subjectid: "subject1", subjectcode: "TEST SUBJECT(CS101)",
    Psubjectcomponentid: "p1", Ppercentage: 50,
  }] });
  cache("att.subject", { P: { student_attdsummarylist: [{ present: "Y" }, { present: "N" }] } }, "sem1", "subject1");
  const html = render(AttendancePage);
  assert.match(html, /1\/2 classes/);
  assert.match(html, /50\.0%<\/span>/);
});

test("subject sheet never calls a known attendance percentage No classes held", () => {
  const row = { subjectid: "subject1", subjectcode: "TEST LAB(CS101)", Psubjectcomponentid: "p1", Ppercentage: 83.3 };
  const renderSheet = () => renderToStaticMarkup(createElement(SubjectDetailSheet, {
    row, session, registrationid: "sem1", onClose() {}, onLogout() {},
  }));
  assert.doesNotMatch(renderSheet(), /No classes held yet/);
  cache("att.subject", { P: { student_attdsummarylist: [] } }, "sem1", "subject1");
  const html = renderSheet();
  assert.match(html, /83\.3%/);
  assert.doesNotMatch(html, /No classes held yet/);
  assert.match(html, /No class records available/);
  row.Ppercentage = 0;
  assert.match(renderSheet(), /No classes held yet/);
});

// Simulate a browser whose image decoder fails, so a fetched image must remain
// available for manual entry even when autosolving fails.
async function withFailedDecoder(run) {
  const image = globalThis.Image;
  const canvas = globalThis.OffscreenCanvas;
  globalThis.Image = class { async decode() { throw new Error("Cannot decode image"); } };
  globalThis.OffscreenCanvas = class {};
  try { return await run(); }
  finally {
    if (image === undefined) delete globalThis.Image; else globalThis.Image = image;
    if (canvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = canvas;
  }
}

test("captcha fetch failure rejects after retries so login/reconnect can display the error", async (t) => {
  const error = new Error("You are offline.");
  const get = t.mock.method(client, "getPublic", async () => { throw error; });
  await withFailedDecoder(async () => {
    await assert.rejects(fetchAutosolvedCaptcha(), (e) => e === error);
    assert.equal(get.mock.callCount(), 5);
  });
});

test("captcha fetch failure also surfaces when image/canvas APIs are unavailable", async (t) => {
  const error = new Error("Portal unavailable");
  t.mock.method(client, "getPublic", async () => { throw error; });
  await assert.rejects(fetchAutosolvedCaptcha(), (e) => e === error);
});

test("captcha cancellation stays silent and stops further retries", async (t) => {
  const controller = new AbortController();
  const get = t.mock.method(client, "getPublic", async () => {
    controller.abort();
    throw new Error("Aborted");
  });
  await withFailedDecoder(async () => {
    assert.deepEqual(await fetchAutosolvedCaptcha(5, { signal: controller.signal }), {
      captcha: null, text: "", autoSolved: false,
    });
    assert.equal(get.mock.callCount(), 1);
  });
});

test("failed autosolving still returns a fetched captcha for manual entry", async (t) => {
  t.mock.method(client, "getPublic", async () => ({ response: { captcha: { hidden: "fixture", image: "fixture" } } }));
  await withFailedDecoder(async () => {
    const result = await fetchAutosolvedCaptcha();
    assert.equal(result.captcha.hidden, "fixture");
    assert.equal(result.autoSolved, false);
  });
});

test("captcha fetching can recover after a transient network failure", async (t) => {
  let calls = 0;
  t.mock.method(client, "getPublic", async () => {
    if (++calls === 1) throw new Error("Temporary network failure");
    return { response: { captcha: { hidden: "recovered", image: "fixture" } } };
  });
  await withFailedDecoder(async () => {
    const result = await fetchAutosolvedCaptcha();
    assert.equal(result.captcha.hidden, "recovered");
  });
});
