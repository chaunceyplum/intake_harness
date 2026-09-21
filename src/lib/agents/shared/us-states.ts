/**
 * The states a brief might name, and what a profile store might hold for them.
 *
 * WHY THIS IS A SHARED MODULE AND NOT A LIST INSIDE THE AUDIENCE AGENT
 *
 * It was a list inside the audience agent, of twenty states, and the geography
 * requirement was triggered by a different, shorter list of place WORDS -
 * "state|region|market|county|city|zip|postal|radius|northeast|southeast|
 * midwest|west|detroit|michigan". Those two lists disagreed, and the second one
 * decided whether geography was considered at all.
 *
 * So a brief reading "existing residential subscribers in Pennsylvania" raised
 * no geography requirement, produced no geographic predicate, and recorded
 * nothing as missing. The audience that got built and reported as complete was
 * every no-Internet customer with an email address, in any state - against a
 * real launch date and a real budget. "Detroit" and "michigan" were in the
 * trigger list because they were in the brief we happened to develop against.
 *
 * Intake needs the same knowledge to put "Pennsylvania" in the region field, so
 * it lives here rather than in either agent.
 *
 * THE VALUE DOMAIN IS NOT KNOWN IN ADVANCE
 *
 * The sandbox's `state` field holds full names ("New York"). Our list mapped to
 * two-letter codes, so even a working geography path would have written
 * `state = "PA"` and matched nobody - a segment of zero reported as a segment.
 * Both spellings are therefore kept, and the predicate tests for either rather
 * than betting on one.
 */

/** name as a brief writes it -> USPS code. All 50 states, DC and PR. */
export const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};

/** Title Case, as the value is most likely written in a profile store. */
function titleCase(name: string): string {
  return name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export type NamedState = { name: string; code: string };

/**
 * The state a brief names, if it names one.
 *
 * Full names only. A two-letter code is NOT matched: "in OR" is the word "or",
 * "MA" appears inside ordinary words, and a false geography filter is worse
 * than none - it would silently exclude almost everybody while looking precise.
 * A brief that writes only a code will fall through to being asked, which is
 * the correct outcome for something this consequential.
 */
export function findState(text: string): NamedState | null {
  const haystack = ` ${String(text || "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ")} `;
  // Longest first, so "west virginia" is not read as "virginia".
  const names = Object.keys(US_STATES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (haystack.includes(` ${name} `)) return { name: titleCase(name), code: US_STATES[name] };
  }
  return null;
}

/*
 * Words that follow a locative preposition without naming a place.
 * "launch in November" is not a geography, and neither is "for Xfinity".
 */
const NOT_PLACES = new RegExp(
  "^(january|february|march|april|may|june|july|august|september|october|november|december|" +
    "q[1-4]|comcast|xfinity|internet|tv|email|sms|push|growth|retention|acquisition|" +
    "monday|tuesday|wednesday|thursday|friday|saturday|sunday|the|this|that|order|fact|" +
    "addition|particular|general|short|line|place|time|full|which|our|their|adobe|workfront)$",
  "i",
);

/**
 * Does this text name a place at all - and does it FAIL SAFE when unsure?
 *
 * Case matters for the loose test below, so pass the ORIGINAL text rather than
 * a lowercased copy.
 */
export function namesAPlace(text: string): boolean {
  const raw = String(text || "");
  if (findState(raw)) return true;

  if (/\b(state|states|region|market|dma|county|city|zip|postal|footprint|territory|nationwide|national|northeast|southeast|midwest|southwest|west coast|east coast|metro|metropolitan|suburb|suburbs|greater|catchment|radius)\b/i.test(raw)) {
    return true;
  }

  /*
   * The loose test, and it is loose on purpose.
   *
   * Widening a word list does not fix the SHAPE of the original bug - the next
   * brief says "around the Detroit metro area", or "Chicagoland", or "our
   * northern footprint", and slips through in silence exactly as Pennsylvania
   * did. So a locative preposition followed by a proper noun counts as naming
   * a place, whether or not we recognise the name.
   *
   * A false positive costs one question to the marketer. A false negative costs
   * an audience built for the wrong population with a plausible count attached
   * to it. That asymmetry decides which way to lean.
   */
  const locative = /\b(?:in|around|across|within|near|throughout|serving|covering)\s+(?:the\s+)?([A-Z][a-zA-Z]+)/g;
  for (const m of raw.matchAll(locative)) {
    if (!NOT_PLACES.test(m[1])) return true;
  }
  return false;
}

/**
 * A predicate that matches the state however the store spells it.
 *
 * We do not know whether this tenant holds "Pennsylvania" or "PA", and reading
 * the schema does not say - both are strings. Testing for either is honest
 * about that and correct in both cases; picking one silently returns an empty
 * audience in the other, which reads as "nobody qualifies" rather than "we
 * guessed the format".
 */
export function statePredicate(field: string, state: NamedState): string {
  return `(${field} = "${state.name}" or ${field} = "${state.code}")`;
}

/**
 * EVERY state the text names, in the order it names them.
 *
 * findState returns the first and stops, which was invisible until a brief
 * asked for two:
 *
 *   "Xfinity Internet customers in New York and New Jersey"
 *
 * captured New Jersey alone. Half the requested audience was dropped with
 * nothing reported - and the audience agent builds its filter from that value,
 * so the campaign would have gone to one state of the two.
 *
 * The first still fills the field. The rest exist so the loss can be SEEN and
 * asked about, which is the same rule the dates and offers follow.
 */
export function findStates(text: string): NamedState[] {
  const raw = String(text || "");
  const out: NamedState[] = [];
  const seen = new Set<string>();

  const hits: Array<{ at: number; state: NamedState }> = [];
  for (const [name, code] of Object.entries(US_STATES)) {
    // Word-bounded, so "Washington" does not match inside "Washington Post"
    // any more or less than findState already allows.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const m = re.exec(raw);
    if (m) hits.push({ at: m.index, state: { name, code } });
  }

  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) {
    if (seen.has(h.state.code)) continue;
    seen.add(h.state.code);
    out.push(h.state);
  }
  return out;
}
