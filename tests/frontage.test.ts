import { test } from "node:test";
import assert from "node:assert/strict";
import { findProspectsViaFrontageLeads, resolveCountryCodes, toList } from "../src/lib/frontage-prospecting.ts";

const countries = { countries: [{ country: "GB", name: "United Kingdom" }, { country: "US", name: "United States" }] };

type Log = { tool: string; args: Record<string, unknown> }[];

function fakeCall(log: Log) {
  return async (tool: string, args: Record<string, unknown>) => {
    log.push({ tool, args });
    if (tool === "list_countries") return countries;
    if (tool === "list_categories") return { categories: args.contains === "real_estate" ? ["real_estate_agency"] : [] };
    return {
      leads: [
        { name: ` ${args.country}-${args.city ?? "all"}-${args.category ?? args.search ?? "any"} `, email: `X@${args.country}.com` },
        { name: "dup", email: `x@${args.country}.com` },
      ],
    };
  };
}

test("toList handles arrays and comma strings", () => {
  assert.deepEqual(toList(["A", " b "]), ["A", "b"]);
  assert.deepEqual(toList("A, b;c"), ["A", "b", "c"]);
  assert.deepEqual(toList(undefined), []);
});

test("countries resolve by name, code and UK alias; unknown is reported", async () => {
  const r = await resolveCountryCodes(fakeCall([]), ["United Kingdom", "us", "UK", "Atlantis"]);
  assert.deepEqual(r.codes, ["GB", "US"]);
  assert.deepEqual(r.unknown, ["Atlantis"]);
});

test("filters reach search_leads and results change with them", async () => {
  const log: Log = [];
  const a = (await findProspectsViaFrontageLeads({ countries: ["United States"], cities: [], industries: ["real estate"], keywords: [], limit: 5 }, fakeCall(log))).prospects;
  const first = log.find((l) => l.tool === "search_leads")!;
  assert.equal(first.args.country, "US");
  assert.equal(first.args.category, "real_estate_agency");
  assert.equal(first.args.has_email, true);

  log.length = 0;
  const b = (await findProspectsViaFrontageLeads({ countries: ["United Kingdom"], cities: ["London"], industries: ["dentists"], keywords: [], limit: 5 }, fakeCall(log))).prospects;
  const second = log.find((l) => l.tool === "search_leads")!;
  assert.equal(second.args.country, "GB");
  assert.equal(second.args.city, "London");
  assert.equal(second.args.search, "dentists"); // no category match -> free-text fallback
  assert.notDeepEqual(a.map((p) => p.email), b.map((p) => p.email));
});

test("dedupes emails case-insensitively and respects the limit", async () => {
  const { prospects: out } = await findProspectsViaFrontageLeads({ countries: ["GB"], cities: [], industries: [], keywords: [], limit: 1 }, fakeCall([]));
  assert.equal(out.length, 1);
  assert.equal(out[0].email, "x@gb.com");
  assert.equal(out[0].name, "GB-all-any");
});

test("rejects when no country recognised (no silent broadening)", async () => {
  await assert.rejects(findProspectsViaFrontageLeads({ countries: ["Atlantis"], cities: [], industries: [], keywords: [], limit: 3 }, fakeCall([])), /Unrecognised target country/);
  await assert.rejects(findProspectsViaFrontageLeads({ countries: [], cities: [], industries: [], keywords: [], limit: 3 }, fakeCall([])), /at least one/);
});

test("excluded_locations: an excluded country is never searched at all", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["United States", "United Kingdom"], cities: [], industries: [], keywords: [], limit: 5, excludedLocations: ["United States"] },
    fakeCall(log)
  );
  const countriesSearched = log.filter((l) => l.tool === "search_leads").map((l) => l.args.country);
  assert.ok(countriesSearched.length > 0);
  assert.ok(countriesSearched.every((c) => c === "GB"), "US must never be searched once excluded");
});

test("excluded_locations: a row whose city contains an excluded city name is dropped, even scanning a whole country", async () => {
  const excludeCityCall = async (tool: string, args: Record<string, unknown>) => {
    if (tool === "list_countries") return countries;
    if (tool === "list_categories") return { categories: [] };
    return {
      leads: [
        { name: "Mumbai Textiles", email: "a@mt.com", city: "Mumbai" },
        { name: "Delhi Traders", email: "b@dt.com", city: "Delhi" },
      ],
    };
  };
  const { prospects } = await findProspectsViaFrontageLeads(
    { countries: ["United Kingdom"], cities: [], industries: [], keywords: [], limit: 5, excludedLocations: ["Mumbai"] },
    excludeCityCall
  );
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].email, "b@dt.com");
});

function proposalCall(log: Log) {
  return async (tool: string, args: Record<string, unknown>) => {
    log.push({ tool, args });
    if (tool === "list_countries") return countries;
    if (tool === "list_categories") return { categories: ["dentist", "dental_clinic"].filter((c) => c.includes(String(args.contains))) };
    if (tool === "list_cities") return { cities: ["London", "Greater London"].filter((c) => c.toLowerCase().includes(String(args.contains).toLowerCase())) };
    return { leads: [{ name: "Acme Dental", email: "hi@acme.co.uk", city: args.city }] };
  };
}

test("AI proposals are validated: bad slugs dropped, city spelled as the connector has it", async () => {
  const log: Log = [];
  const { prospects: out } = await findProspectsViaFrontageLeads(
    { countries: ["United Kingdom"], cities: ["london"], industries: ["dentists"], keywords: [], limit: 3 },
    proposalCall(log),
    [{ country: "GB", city: "london", categories: ["dentist", "made_up_slug"], search: null }]
  );
  const search = log.find((l) => l.tool === "search_leads")!;
  assert.equal(search.args.country, "GB");
  assert.equal(search.args.city, "London");
  assert.equal(search.args.category, "dentist");
  assert.equal(log.filter((l) => l.tool === "search_leads" && l.args.category === "made_up_slug").length, 0);
  assert.equal(out[0].email, "hi@acme.co.uk");
});

test("AI cannot widen scope: a country the form did not name is ignored", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["United Kingdom"], cities: [], industries: ["dentist"], keywords: [], limit: 3 },
    proposalCall(log),
    [{ country: "US", city: null, categories: ["dentist"], search: null }]
  );
  const countriesSearched = log.filter((l) => l.tool === "search_leads").map((l) => l.args.country);
  assert.ok(countriesSearched.length > 0);
  assert.ok(countriesSearched.every((c) => c === "GB"));
});

test("a city the connector's shortlist lacks is still passed as the exact city filter, never folded into a name-matching keyword", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["GB"], cities: ["Narnia"], industries: [], keywords: [], limit: 3 },
    proposalCall(log),
    [{ country: "GB", city: "Narnia", categories: ["dentist"], search: null }]
  );
  const search = log.find((l) => l.tool === "search_leads")!;
  // Folding an unmatched city into `search` used to match it against a business's NAME too — a company
  // named "... of Greater Narnia" would wrongly match even if actually located elsewhere. The city always
  // goes through the exact `city` param instead, canonical or not.
  assert.equal(search.args.city, "Narnia");
  assert.equal(search.args.search, undefined);
});

test("a row whose own city field doesn't exactly match the requested city is dropped, even if it matched on name/category", async () => {
  const log: Log = [];
  const wrongCityCall = async (tool: string, args: Record<string, unknown>) => {
    log.push({ tool, args });
    if (tool === "list_countries") return countries;
    if (tool === "list_categories") return { categories: ["real_estate_agent"] };
    if (tool === "list_cities") return { cities: ["Los Angeles"] };
    return {
      leads: [
        { name: "Real LA Realty", email: "real@la.com", city: "Los Angeles" },
        { name: "Tony - Los Angeles Realtor", email: "tony@bh.com", city: "Beverly Hills" },
      ],
    };
  };
  const { prospects } = await findProspectsViaFrontageLeads(
    { countries: ["US"], cities: ["Los Angeles"], industries: ["real estate"], keywords: [], limit: 10 },
    wrongCityCall,
    [{ country: "US", city: "Los Angeles", categories: ["real_estate_agent"], search: null }]
  );
  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].email, "real@la.com");
});

test("a category the connector lacks is kept as a keyword search, not lost", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["GB"], cities: [], industries: [], keywords: [], limit: 3 },
    proposalCall(log),
    [{ country: "GB", city: null, categories: ["dentist", "real_estate_agency"], search: null }]
  );
  const searches = log.filter((l) => l.tool === "search_leads").map((l) => l.args);
  assert.ok(searches.some((a) => a.category === "dentist"));
  assert.ok(searches.some((a) => a.search === "real estate agency"));
});

const GB_CATEGORIES = ["commercial_real_estate", "real_estate", "real_estate_agent", "real_estate_investment", "real_estate_law", "real_estate_photography", "real_estate_service", "estate_planning_law", "dentist", "dental_clinic", "apartment_agent", "travel_agents"];
function realEstateCall(log: Log) {
  return async (tool: string, args: Record<string, unknown>) => {
    log.push({ tool, args });
    if (tool === "list_countries") return countries;
    if (tool === "list_categories") return { categories: GB_CATEGORIES.filter((c) => c.includes(String(args.contains))) };
    return { leads: [{ name: "Acme Estates", email: "hi@acme-estates.co.uk" }] };
  };
}

test("a guessed slug maps to the connector's closest real category (real_estate_agency -> real_estate_agent)", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["GB"], cities: [], industries: [], keywords: [], limit: 3 },
    realEstateCall(log),
    [{ country: "GB", city: null, categories: ["real_estate_agency"], search: null }]
  );
  const searched = log.filter((l) => l.tool === "search_leads").map((l) => l.args);
  assert.ok(searched.some((a) => a.category === "real_estate_agent"), "should use the real slug");
  assert.ok(!searched.some((a) => a.category === "real_estate_law" || a.category === "estate_planning_law"), "must not drift to unrelated categories");
});

test("nothing close -> keyword fallback, never a wrong category", async () => {
  const log: Log = [];
  await findProspectsViaFrontageLeads(
    { countries: ["GB"], cities: [], industries: [], keywords: [], limit: 3 },
    realEstateCall(log),
    [{ country: "GB", city: null, categories: ["submarine_repair"], search: null }]
  );
  const searched = log.filter((l) => l.tool === "search_leads").map((l) => l.args);
  assert.ok(searched.every((a) => a.category === undefined));
  assert.ok(searched.some((a) => a.search === "submarine repair"));
});
