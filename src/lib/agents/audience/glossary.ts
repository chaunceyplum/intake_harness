/**
 * The business's own vocabulary, for PQL synthesis (pql-synth.ts).
 *
 * Field titles use the business's abbreviations ("Has SEP", "Is CBM
 * member"); marketers write either form ("Security Edge Preferred
 * customers"). Without this the model could not connect the two and
 * refused, and read "companies with more than 50 employees" as having no
 * company-level field on a person profile (plain-language eval, 26 Sep
 * 2026: 6/17 briefs passed before this, see the commit that added it).
 *
 * Edit here when the business adds a product or an abbreviation - it is
 * data, not logic.
 */

export const BUSINESS_GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: "CB", meaning: "Comcast Business" },
  { term: "CBM", meaning: "Comcast Business Mobile" },
  { term: "CB Internet", meaning: "Comcast Business Internet" },
  { term: "SEP", meaning: "Security Edge Preferred, a Comcast Business security product" },
];

/** How this business's profiles and flags are meant to be read. */
export const BUSINESS_CONTEXT: string[] = [
  "Profiles are contacts at Comcast Business customer companies. Company-level attributes (Company Size is " +
    "the number of employees) and product flags live on the profile itself, so \"companies/businesses with ...\" " +
    "selects profiles whose attributes match - it is not a separate entity.",
  "An unqualified product word means the Comcast Business product: \"mobile\" is CBM, \"internet\" is CB Internet.",
  "Having or being a member of a product is its Y/N flag = \"Y\"; not having it is = \"N\"; being eligible for " +
    "it is its eligibility flag.",
  "\"Valid email\" / \"emailable\" is the Valid email address flag = \"Y\"; an invalid email is that flag = \"N\". " +
    "\"People we can contact / email\" also excludes Do not contact = \"Y\". Exclusions of a flag are " +
    "!= \"Y\" so unflagged profiles stay in.",
];

/** The glossary and context as one prompt section. */
export function glossaryPrompt(): string {
  return [
    "Business glossary (the marketer may use either form):",
    ...BUSINESS_GLOSSARY.map((g) => `- ${g.term} = ${g.meaning}`),
    "How to read this business's data:",
    ...BUSINESS_CONTEXT.map((c) => `- ${c}`),
  ].join("\n");
}
