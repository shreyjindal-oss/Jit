import assert from "node:assert/strict";
import { detectAccess, accessFit } from "../src/access";
import { rowsToBodies, parseSheet } from "../src/batch";
import { validate } from "../src/pipeline";

// --- accessibility detection
const g = detectAccess("2 bed ground floor flat to rent", "Level access, wet room, close to station");
assert.equal(g.floor, "Ground"); assert.ok(g.groundFloor && g.stepFree);
assert.equal(accessFit(g, "ground_floor"), "fit"); assert.equal(accessFit(g, "step_free"), "fit");
const up = detectAccess("3rd floor apartment", "Spacious flat with balcony");
assert.equal(up.floor, "3rd"); assert.equal(accessFit(up, "step_free"), "no"); assert.equal(accessFit(up, "ground_floor"), "no");
const upLift = detectAccess("Fifth floor apartment", "Concierge, residents' lift, gym");
assert.equal(upLift.floorLevel, 5); assert.ok(upLift.lift); assert.equal(accessFit(upLift, "step_free"), "fit"); assert.equal(accessFit(upLift, "ground_floor"), "no");
const bung = detectAccess("3 bedroom detached bungalow to rent");
assert.equal(bung.floor, "Bungalow"); assert.equal(accessFit(bung, "ground_floor"), "fit");
const unk = detectAccess("2 bedroom flat to rent", "Modern kitchen");
assert.equal(accessFit(unk, "step_free"), "unknown");
const wc = detectAccess("Wheelchair accessible ground floor apartment");
assert.equal(accessFit(wc, "wheelchair"), "fit");
assert.equal(detectAccess("Lower ground floor flat").floor, "Lower ground");
assert.equal(validate({ location: "E14", checkIn: "2026-10-01", checkOut: "2026-12-01", bedrooms: 3, accessibility: "step_free" }).req!.accessibility, "step_free");

// --- sheet parsing (CSV with aliases, UK dates, "3 bed", quoted commas)
const csv = `Postcode,Arrival,Departure,Bed type,Budget,Access,Client,Enquiry ID\n"Canary Wharf, London",01/11/2026,01/02/2027,2 bed,"£3,500",Ground floor,Acme,ENQ-1\nM1 1AE,2026-12-01,2027-03-01,Studio,,wheelchair user,,ENQ-2\n,,,,,,,\n`;
const rows = await parseSheet(new TextEncoder().encode(csv).buffer);
assert.equal(rows.length, 2);
const bodies = rowsToBodies(rows);
assert.deepEqual([bodies[0].location, bodies[0].checkIn, bodies[0].checkOut, bodies[0].bedrooms, bodies[0].maxRentPcm, bodies[0].accessibility, bodies[0].enquiryRef],
  ["Canary Wharf, London", "2026-11-01", "2027-02-01", "2", "3500", "ground_floor", "ENQ-1"]);
assert.equal(bodies[1].bedrooms, "0"); assert.equal(bodies[1].accessibility, "wheelchair");
assert.ok(validate(bodies[0]).req && validate(bodies[1]).req);
console.log("ACCESS + BATCH OK");
