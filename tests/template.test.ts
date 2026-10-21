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
  assert.equal(e.subject, "Quick question about Acme Dental");
  assert.equal(
    e.body,
    [
      "Hi Sam,",
      "",
      "Since Acme Dental works in dental care, I thought this might be relevant.",
      "",
      "I'm reaching out because we help businesses automate repetitive tasks, including lead follow-ups and customer inquiries, using AI.",
      "",
      "For a business like yours, this could mean less manual work and faster responses to potential customers.",
      "",
      "Would you be open to a quick conversation to see whether this could be useful for Acme Dental?",
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
