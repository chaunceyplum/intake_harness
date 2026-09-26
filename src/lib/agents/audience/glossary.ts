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
  "Y/N flags: what the marketer asks for is = \"Y\" (\"has SEP\" -> hasSEP = \"Y\"); its opposite is = \"N\" " +
    "(\"doesn't have SEP\" -> hasSEP = \"N\"; \"email is not valid\" / \"invalid email\" -> validEmailFlag = \"N\"). " +
    "Being eligible for a product is its eligibility flag.",
  "Only when EXCLUDING people who carry a flag (\"excluding do not contact\", \"not on the do-not-contact list\") " +
    "write != \"Y\" (doNotContact != \"Y\"), so profiles with no value stay in. Never write != \"N\" - it selects " +
    "the opposite of a \"not ...\" request.",
  "\"Valid email\" / \"emailable\" is validEmailFlag = \"Y\". \"People we can contact / email\" also means " +
    "doNotContact != \"Y\".",
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
