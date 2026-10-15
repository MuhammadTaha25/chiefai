import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCustomTemplate, unknownPlaceholders, SAMPLE_VALUES } from "../src/lib/custom-template.ts";

test("only the known placeholders are accepted; a typo is reported", () => {
  assert.deepEqual(unknownPlaceholders("Hi {first_name}, about {company}"), []);
  assert.deepEqual(unknownPlaceholders("Hi {compnay} and {first_name}"), ["compnay"]);
});

test("renders values and never invents one: missing name becomes 'there', missing company 'your company'", () => {
  const out = renderCustomTemplate("About {company}", "Hi {first_name}, we help {company}.", { company: "Acme", first_name: null });
  assert.equal(out.subject, "About Acme");
  assert.equal(out.body, "Hi there, we help Acme.");
  const none = renderCustomTemplate("Hello", "Hi {first_name}, {industry} {company}", {});
  assert.equal(none.body, "Hi there,  your company");
});

test("sample values render a complete email", () => {
  const out = renderCustomTemplate("Quick question about {company}", "Hi {first_name}, {industry} team?", SAMPLE_VALUES);
  assert.equal(out.body, "Hi Sam, dental care team?");
});

test("{first_name} is only the first word of the name (never 'Hi Sam Agent,')", () => {
  const out = renderCustomTemplate("Hi {first_name}", "Hi {first_name}, hello.", { first_name: "  Sam   Agent " });
  assert.equal(out.subject, "Hi Sam");
  assert.match(out.body, /^Hi Sam, hello\./);
});
