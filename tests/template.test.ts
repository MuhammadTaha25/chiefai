import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemplateEmail } from "../src/lib/outreach-template.ts";
import { lintOutreachEmail } from "../src/lib/email-quality.ts";

const vars = {
  firstName: "Sam Jones",
  leadCompany: "Acme Dental",
  industry: "dental care",
  offer: "automate repetitive tasks, including lead follow-ups and customer inquiries, using AI.",
  benefit: "less manual work and faster responses to potential customers",
  senderName: "Priya",
  senderCompany: "Infomist",
  website: "infomist.com",
};

test("fills the fixed structure and signature", () => {
  const e = buildTemplateEmail(vars);
  assert.match(e.subject, /Acme Dental/);
  assert.doesNotMatch(e.subject, /quick question/i);
  assert.equal(
    e.body,
    [
      "Hi Sam,",
      "",
      "Since Acme Dental works in dental care, I thought this might be relevant.",
      "",
      "We help businesses automate repetitive tasks, including lead follow-ups and customer inquiries, using AI. For a business like yours, that could mean less manual work and faster responses to potential customers.",
      "",
      "Is this on your radar at Acme Dental, or is now not a good time?",
      "",
      "Best,",
      "Priya",
      "Infomist",
      "infomist.com",
    ].join("\n")
  );
  assert.deepEqual(lintOutreachEmail(e), []);
});

test("missing variables are dropped, never invented", () => {
  const e = buildTemplateEmail({ ...vars, firstName: null, industry: null, senderName: null, website: null });
  assert.ok(e.body.startsWith("Hi there,"));
  assert.ok(e.body.includes("I'm getting in touch about Acme Dental."));
  assert.ok(!e.body.includes("working in"));
  assert.ok(e.body.endsWith("Best,\nInfomist"));
});

import { bareDomain } from "../src/lib/outreach-template.ts";

test("opener uses the recipient's job title when the industry is unknown; industry still wins when known", () => {
  const withTitle = buildTemplateEmail({ ...vars, industry: null, jobTitle: "Practice Owner" });
  assert.ok(withTitle.body.includes("With your role as Practice Owner at Acme Dental, I thought this might be relevant."));
  assert.deepEqual(lintOutreachEmail(withTitle), []);
  const withBoth = buildTemplateEmail({ ...vars, jobTitle: "Practice Owner" });
  assert.ok(withBoth.body.includes("works in dental care"));
  assert.ok(!withBoth.body.includes("Practice Owner"));
  const neither = buildTemplateEmail({ ...vars, industry: null, jobTitle: null });
  assert.ok(neither.body.includes("I'm getting in touch about Acme Dental."));
});

test("website in the signature is a bare domain, so a real client's site never trips the no-links rule", () => {
  assert.equal(bareDomain("https://www.infomist.com/"), "infomist.com");
  assert.equal(bareDomain("http://Example.COM/path?x=1"), "example.com");
  assert.equal(bareDomain(null), "");
  const e = buildTemplateEmail({ ...vars, website: "https://www.infomist.com" });
  assert.ok(e.body.endsWith("Infomist\ninfomist.com"));
  assert.deepEqual(lintOutreachEmail(e), []);
});

test("an industry slug with underscores reads as plain words in the opener", () => {
  const e = buildTemplateEmail({ ...vars, industry: "real_estate" });
  assert.match(e.body, /works in real estate,/);
  assert.doesNotMatch(e.body, /real_estate/);
});

import { templateSubject, subjectStyleFor } from "../src/lib/outreach-template.ts";

test("subjects vary across leads, are stable per lead, never say 'quick question', and always name the company", () => {
  const names = ["Acme Dental", "Harbor Lane Realty", "Bright Smile Studio", "Oak & Pine Law", "Delta Plumbing", "Nova Fitness", "Riverbend Cafe", "Summit Roofing"];
  const subjects = names.map((c) => templateSubject(c, "Sam", "dental care"));
  assert.ok(new Set(subjects.map((s) => s.replace(/Acme Dental|Harbor Lane Realty|Bright Smile Studio|Oak & Pine Law|Delta Plumbing|Nova Fitness|Riverbend Cafe|Summit Roofing/, "X"))).size >= 3, "at least 3 different patterns");
  names.forEach((c, i) => {
    assert.ok(subjects[i].includes(c), "company named");
    assert.ok(subjects[i].length <= 50);
    assert.doesNotMatch(subjects[i], /quick question/i);
    assert.equal(templateSubject(c, "Sam", "dental care"), subjects[i], "stable for the same lead");
  });
  assert.doesNotMatch(templateSubject("Acme", "", ""), /undefined|\{|\}/);
  assert.ok(subjectStyleFor("a|b").length > 10);
  assert.equal(subjectStyleFor("a|b"), subjectStyleFor("a|b"));
});
