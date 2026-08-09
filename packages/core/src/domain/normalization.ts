import type { FlowType, NormalizationUncertaintyCode } from "./types";

export const CATEGORY_TAXONOMY = {
  housing: { displayName: "Housing", requiredDefault: true },
  utilities: { displayName: "Utilities", requiredDefault: true },
  insurance: { displayName: "Insurance", requiredDefault: true },
  transportation: { displayName: "Transportation", requiredDefault: false },
  groceries: { displayName: "Groceries", requiredDefault: false },
  dining: { displayName: "Dining", requiredDefault: false },
  coffee_snacks: { displayName: "Coffee and snacks", requiredDefault: false },
  entertainment: { displayName: "Entertainment", requiredDefault: false },
  streaming: { displayName: "Streaming", requiredDefault: false },
  music_audio: { displayName: "Music and audio", requiredDefault: false },
  software: { displayName: "Software", requiredDefault: false },
  cloud_storage: { displayName: "Cloud storage", requiredDefault: false },
  fitness: { displayName: "Fitness", requiredDefault: false },
  shopping: { displayName: "Shopping", requiredDefault: false },
  travel: { displayName: "Travel", requiredDefault: false },
  medical: { displayName: "Medical", requiredDefault: true },
  education: { displayName: "Education", requiredDefault: false },
  childcare: { displayName: "Childcare", requiredDefault: true },
  debt_payment: { displayName: "Debt payment", requiredDefault: true },
  savings_transfer: { displayName: "Savings transfer", requiredDefault: true },
  income: { displayName: "Income", requiredDefault: false },
  transfer: { displayName: "Transfer", requiredDefault: false },
  credit_card_payment: { displayName: "Credit card payment", requiredDefault: true },
  fees: { displayName: "Fees", requiredDefault: false },
  cash: { displayName: "Cash", requiredDefault: false },
  unknown: { displayName: "Unknown", requiredDefault: false },
} as const;

export type NormalizedCategoryId = keyof typeof CATEGORY_TAXONOMY;

export type CategoryMetadata = {
  category: NormalizedCategoryId;
  displayName: string;
  requiredDefault: boolean;
};

export type NormalizedStatementTransaction = {
  merchantName: string;
  normalizedMerchantId: string;
  merchantCanonical: string;
  merchantAmbiguity: boolean;
  category: NormalizedCategoryId;
  categoryDisplayName: string;
  categoryRequiredDefault: boolean;
  flowType: FlowType;
  confidence: number;
  confidenceReason: string;
  uncertaintyCodes: NormalizationUncertaintyCode[];
};

type CategoryAliasValue = NormalizedCategoryId | "refund_marker";

type MerchantAliasRule = {
  id: string;
  displayName: string;
  category?: NormalizedCategoryId;
  ambiguousProcessor?: boolean;
  patterns: RegExp[];
};

const CATEGORY_ALIASES: Record<string, CategoryAliasValue> = {
  "bank fee": "fees",
  "bank fees": "fees",
  "bank fees monthly fee": "fees",
  "bank fees overdraft": "fees",
  "bank fees atm fee": "fees",
  cafe: "coffee_snacks",
  "cash withdrawal": "cash",
  childcare: "childcare",
  "child care": "childcare",
  credit: "refund_marker",
  "credit card payment": "credit_card_payment",
  "credit card payments": "credit_card_payment",
  dining: "dining",
  "debt payment": "debt_payment",
  education: "education",
  entertainment: "entertainment",
  fee: "fees",
  fees: "fees",
  fitness: "fitness",
  food: "dining",
  "food and drink": "dining",
  "food and drink coffee": "coffee_snacks",
  "food and drink fast food": "dining",
  "food and drink groceries": "groceries",
  "food and drink restaurants": "dining",
  groceries: "groceries",
  grocery: "groceries",
  "general merchandise": "shopping",
  "general services": "shopping",
  health: "medical",
  healthcare: "medical",
  income: "income",
  insurance: "insurance",
  interest: "income",
  loan: "debt_payment",
  medical: "medical",
  "medical pharmacies and supplements": "medical",
  "music and audio": "music_audio",
  "payment": "transfer",
  payroll: "income",
  refund: "refund_marker",
  rent: "housing",
  restaurant: "dining",
  restaurants: "dining",
  "shops": "shopping",
  "shops digital purchase": "software",
  "shops electronics": "shopping",
  "shops gifts and novelties": "shopping",
  "shops superstores": "shopping",
  shopping: "shopping",
  "taxi": "transportation",
  transportation: "transportation",
  transfer: "transfer",
  "transfer in": "transfer",
  "transfer out": "transfer",
  travel: "travel",
  "travel flights": "travel",
  "travel lodging": "travel",
  utilities: "utilities",
  utility: "utilities",
  // Plaid personal_finance_category codes (underscores become spaces, lowercased
  // by normalizeCategoryText). Primaries are listed so the prefix-reduction in
  // normalizeRawCategory can fall back to them for any unmapped `detailed` code;
  // detailed rows whose category differs from their primary are pinned here. H-036.
  "loan payments": "debt_payment",
  "loan payments car payment": "debt_payment",
  "loan payments student loan payment": "debt_payment",
  "loan payments mortgage": "housing",
  "loan payments other payment": "debt_payment",
  "general merchandise discount stores": "shopping",
  "general merchandise online marketplaces": "shopping",
  "general merchandise superstores": "shopping",
  "home improvement": "shopping",
  "home improvement hardware stores": "shopping",
  "home improvement furniture": "shopping",
  "home improvement home appliances": "shopping",
  "food and drink beer wine and liquor": "dining",
  "food and drink beer wine liquor": "dining",
  "food and drink other food and drink": "dining",
  "food and drink vending machines": "coffee_snacks",
  "personal care": "shopping",
  "personal care hair and beauty": "shopping",
  "personal care laundry and dry cleaning": "shopping",
  "government and non profit donations": "transfer",
  // L-008: broaden PFC coverage beyond the sandbox handful. Because
  // normalizeRawCategory falls back from a `detailed` code to its `primary`
  // prefix, mapping every PFC *primary* makes the whole detailed taxonomy
  // degrade gracefully — an unmapped detailed code lands in the right primary
  // bucket instead of `unknown`. RENT_AND_UTILITIES is the one primary that was
  // still missing (its detailed codes were falling to "rent" -> housing, so
  // internet/electric/water bills were mislabelled Housing). The remaining rows
  // are the detailed codes whose correct category *differs* from their primary;
  // longest-match-wins in normalizeRawCategory means these take precedence over
  // the primary fallback. Codes whose target equals the primary need no row.
  "rent and utilities": "utilities",
  "rent and utilities rent": "housing",
  "personal care gyms and fitness centers": "fitness",
  "general services childcare": "childcare",
  "general services education": "education",
  "general services insurance": "insurance",
  "general services automotive": "transportation",
  "entertainment tv and movies": "streaming",
  "entertainment music and audio": "music_audio",
  "loan payments credit card payment": "credit_card_payment",
  "transfer out savings": "savings_transfer",
  "transfer out investment and retirement funds": "savings_transfer",
};

const MERCHANT_ALIAS_RULES: MerchantAliasRule[] = [
  {
    id: "apple_icloud",
    displayName: "Apple iCloud",
    category: "cloud_storage",
    patterns: [/\bAPPLE ICLOUD\b/, /\bICLOUD\b/],
  },
  {
    id: "apple_music",
    displayName: "Apple Music",
    category: "music_audio",
    patterns: [/\bAPPLE MUSIC\b/],
  },
  {
    id: "apple_tv_plus",
    displayName: "Apple TV Plus",
    category: "streaming",
    patterns: [/\bAPPLE TV\b/, /\bAPPLE TV PLUS\b/],
  },
  {
    id: "apple_app_store",
    displayName: "Apple App Store",
    category: "software",
    ambiguousProcessor: true,
    patterns: [/\bAPPLE COM BILL\b/, /\bAPL ITUNES COM BILL\b/, /\bITUNES COM BILL\b/, /\bAPPLE BILL\b/],
  },
  {
    id: "netflix",
    displayName: "Netflix",
    category: "streaming",
    patterns: [/\bNETFLIX\b/, /\bNETFLIX COM\b/],
  },
  {
    id: "hulu",
    displayName: "Hulu",
    category: "streaming",
    patterns: [/\bHULU\b/],
  },
  {
    id: "disney_plus",
    displayName: "Disney Plus",
    category: "streaming",
    patterns: [/\bDISNEY PLUS\b/, /\bDISNEYPLUS\b/],
  },
  {
    id: "spotify",
    displayName: "Spotify",
    category: "music_audio",
    patterns: [/\bSPOTIFY\b/, /\bSPOTIFY USA\b/],
  },
  {
    id: "google_one",
    displayName: "Google One",
    category: "cloud_storage",
    patterns: [/\bGOOGLE ONE\b/, /\bGOOGLE STORAGE\b/],
  },
  {
    id: "adobe",
    displayName: "Adobe Creative Cloud",
    category: "software",
    patterns: [/\bADOBE\b/, /\bCREATIVE CLOUD\b/],
  },
  {
    id: "amazon",
    displayName: "Amazon",
    category: "shopping",
    patterns: [/\bAMAZON\b/, /\bAMZN\b/, /\bAMZN MKTP\b/, /\bAMAZON MARKETPLACE\b/],
  },
  {
    id: "target",
    displayName: "Target",
    category: "shopping",
    patterns: [/\bTARGET\b/, /\bTGT\b/],
  },
  {
    id: "walmart",
    displayName: "Walmart",
    category: "shopping",
    patterns: [/\bWALMART\b/, /\bWM SUPERCENTER\b/],
  },
  {
    id: "costco",
    displayName: "Costco",
    category: "shopping",
    patterns: [/\bCOSTCO\b/],
  },
  {
    id: "whole_foods_market",
    displayName: "Whole Foods Market",
    category: "groceries",
    patterns: [/\bWHOLE FOODS\b/, /\bWHOLEFDS\b/],
  },
  {
    id: "trader_joes",
    displayName: "Trader Joe's",
    category: "groceries",
    patterns: [/\bTRADER JOE\b/, /\bTRADER JOES\b/],
  },
  {
    id: "jewel_osco",
    displayName: "Jewel Osco",
    category: "groceries",
    patterns: [/\bJEWEL OSCO\b/, /\bJEWEL-OSCO\b/],
  },
  {
    id: "kroger",
    displayName: "Kroger",
    category: "groceries",
    patterns: [/\bKROGER\b/],
  },
  {
    id: "starbucks",
    displayName: "Starbucks",
    category: "coffee_snacks",
    patterns: [/\bSTARBUCKS\b/, /\bSBUX\b/],
  },
  {
    id: "blue_bottle_coffee",
    displayName: "Blue Bottle Coffee",
    category: "coffee_snacks",
    patterns: [/\bBLUE BOTTLE\b/],
  },
  {
    id: "taco_deli",
    displayName: "Taco Deli",
    category: "dining",
    patterns: [/\bTACO DELI\b/],
  },
  {
    id: "doordash",
    displayName: "DoorDash",
    category: "dining",
    patterns: [/\bDOORDASH\b/, /\bDD DOORDASH\b/],
  },
  {
    id: "uber_eats",
    displayName: "Uber Eats",
    category: "dining",
    patterns: [/\bUBER EATS\b/, /\bUBEREATS\b/],
  },
  {
    id: "southwest_airlines",
    displayName: "Southwest Airlines",
    category: "travel",
    patterns: [/\bSOUTHWEST\b/, /\bSWA\b/],
  },
  {
    id: "delta_air_lines",
    displayName: "Delta Air Lines",
    category: "travel",
    patterns: [/\bDELTA AIR\b/, /\bDELTA AIR LINES\b/],
  },
  {
    id: "united_airlines",
    displayName: "United Airlines",
    category: "travel",
    patterns: [/\bUNITED AIR\b/, /\bUNITED AIRLINES\b/],
  },
  {
    id: "airbnb",
    displayName: "Airbnb",
    category: "travel",
    patterns: [/\bAIRBNB\b/],
  },
  {
    id: "marriott",
    displayName: "Marriott",
    category: "travel",
    patterns: [/\bMARRIOTT\b/],
  },
  {
    id: "uber",
    displayName: "Uber",
    category: "transportation",
    patterns: [/\bUBER TRIP\b/, /\bUBER\b/],
  },
  {
    id: "lyft",
    displayName: "Lyft",
    category: "transportation",
    patterns: [/\bLYFT\b/],
  },
  {
    id: "shell",
    displayName: "Shell",
    category: "transportation",
    patterns: [/\bSHELL\b/],
  },
  {
    id: "chevron",
    displayName: "Chevron",
    category: "transportation",
    patterns: [/\bCHEVRON\b/],
  },
  {
    id: "comed",
    displayName: "ComEd",
    category: "utilities",
    patterns: [/\bCOMED\b/, /\bCOMMONWEALTH EDISON\b/],
  },
  {
    id: "verizon",
    displayName: "Verizon",
    category: "utilities",
    patterns: [/\bVERIZON\b/],
  },
  {
    id: "city_clinic",
    displayName: "City Clinic",
    category: "medical",
    patterns: [/\bCITY CLINIC\b/],
  },
  {
    id: "cvs",
    displayName: "CVS",
    category: "medical",
    patterns: [/\bCVS\b/],
  },
  {
    id: "walgreens",
    displayName: "Walgreens",
    category: "medical",
    patterns: [/\bWALGREENS\b/],
  },
  {
    id: "madison_bicycle_shop",
    displayName: "Madison Bicycle Shop",
    category: "shopping",
    patterns: [/\bMADISON BICYCLE\b/],
  },
  {
    id: "sparkfun",
    displayName: "SparkFun",
    category: "shopping",
    patterns: [/\bSPARKFUN\b/],
  },
  {
    id: "tectra",
    displayName: "Tectra",
    category: "shopping",
    patterns: [/\bTECTRA\b/],
  },
  {
    id: "touchstone_climbing",
    displayName: "Touchstone Climbing",
    category: "fitness",
    patterns: [/\bTOUCHSTONE\b/],
  },
  {
    // `ACH Electronic CreditGUSTO PAY …` arrives with GUSTO glued to CREDIT, so
    // no `\b` on the left. Direction is ambiguous (payroll in vs. running
    // payroll out), so treat it as an internal transfer — excluded from spend,
    // never asserted as income. See H-036.
    id: "gusto",
    displayName: "Gusto",
    category: "transfer",
    patterns: [/GUSTO PAY/, /\bGUSTO\b/],
  },
  // L-008: common US merchant coverage. A bank CSV frequently carries only
  // date/description/amount — no category column — so for those rows the merchant
  // regex here (plus the `inferCategory` keyword net) is the *only* thing that
  // classifies. Each rule below is a high-frequency, low-ambiguity US merchant
  // whose category is unambiguous from the name alone; ambiguous names (e.g.
  // "SUBWAY", which is both a sandwich chain and transit) are deliberately left
  // to fall through to `unknown` rather than guessed. Patterns are written against
  // the canonicalized text (uppercase, punctuation and long digit runs stripped),
  // so e.g. "MCDONALD'S #1234" is matched as "MCDONALD S". These sit after the
  // existing rules so no established merchant's precedence changes.
  // --- Dining / fast food / delivery ---
  { id: "mcdonalds", displayName: "McDonald's", category: "dining", patterns: [/\bMCDONALDS?\b/] },
  { id: "chipotle", displayName: "Chipotle", category: "dining", patterns: [/\bCHIPOTLE\b/] },
  { id: "chick_fil_a", displayName: "Chick-fil-A", category: "dining", patterns: [/\bCHICK FIL A\b/, /\bCHICKFILA\b/] },
  { id: "taco_bell", displayName: "Taco Bell", category: "dining", patterns: [/\bTACO BELL\b/] },
  { id: "wendys", displayName: "Wendy's", category: "dining", patterns: [/\bWENDY S\b/, /\bWENDYS\b/] },
  { id: "panera", displayName: "Panera Bread", category: "dining", patterns: [/\bPANERA\b/] },
  { id: "dominos", displayName: "Domino's", category: "dining", patterns: [/\bDOMINO S\b/, /\bDOMINOS\b/] },
  { id: "grubhub", displayName: "Grubhub", category: "dining", patterns: [/\bGRUBHUB\b/] },
  { id: "sweetgreen", displayName: "Sweetgreen", category: "dining", patterns: [/\bSWEETGREEN\b/] },
  { id: "panda_express", displayName: "Panda Express", category: "dining", patterns: [/\bPANDA EXPRESS\b/] },
  // --- Coffee ---
  { id: "dunkin", displayName: "Dunkin'", category: "coffee_snacks", patterns: [/\bDUNKIN\b/] },
  { id: "dutch_bros", displayName: "Dutch Bros", category: "coffee_snacks", patterns: [/\bDUTCH BROS\b/] },
  // --- Groceries ---
  { id: "safeway", displayName: "Safeway", category: "groceries", patterns: [/\bSAFEWAY\b/] },
  { id: "aldi", displayName: "Aldi", category: "groceries", patterns: [/\bALDI\b/] },
  { id: "publix", displayName: "Publix", category: "groceries", patterns: [/\bPUBLIX\b/] },
  { id: "instacart", displayName: "Instacart", category: "groceries", patterns: [/\bINSTACART\b/] },
  // --- Shopping / retail (warehouse clubs and superstores follow the Costco = shopping convention) ---
  { id: "sams_club", displayName: "Sam's Club", category: "shopping", patterns: [/\bSAM S CLUB\b/, /\bSAMS CLUB\b/] },
  { id: "best_buy", displayName: "Best Buy", category: "shopping", patterns: [/\bBEST BUY\b/, /\bBESTBUY\b/] },
  { id: "home_depot", displayName: "The Home Depot", category: "shopping", patterns: [/\bHOME DEPOT\b/] },
  { id: "lowes", displayName: "Lowe's", category: "shopping", patterns: [/\bLOWE S\b/, /\bLOWES\b/] },
  { id: "ikea", displayName: "IKEA", category: "shopping", patterns: [/\bIKEA\b/] },
  { id: "ebay", displayName: "eBay", category: "shopping", patterns: [/\bEBAY\b/] },
  { id: "nike", displayName: "Nike", category: "shopping", patterns: [/\bNIKE\b/] },
  // --- Utilities / telecom (recurring bills) ---
  { id: "att", displayName: "AT&T", category: "utilities", patterns: [/\bAT AND T\b/, /\bATT\b/] },
  { id: "t_mobile", displayName: "T-Mobile", category: "utilities", patterns: [/\bT MOBILE\b/, /\bTMOBILE\b/] },
  { id: "xfinity", displayName: "Xfinity", category: "utilities", patterns: [/\bXFINITY\b/, /\bCOMCAST\b/] },
  { id: "spectrum", displayName: "Spectrum", category: "utilities", patterns: [/\bSPECTRUM\b/] },
  // --- Streaming (subscriptions) ---
  { id: "hbo_max", displayName: "Max", category: "streaming", patterns: [/\bHBO MAX\b/, /\bHBO\b/] },
  { id: "peacock", displayName: "Peacock", category: "streaming", patterns: [/\bPEACOCK\b/] },
  { id: "paramount_plus", displayName: "Paramount+", category: "streaming", patterns: [/\bPARAMOUNT\b/] },
  { id: "youtube", displayName: "YouTube", category: "streaming", patterns: [/\bYOUTUBE\b/] },
  // --- Software / cloud (subscriptions) ---
  { id: "microsoft", displayName: "Microsoft", category: "software", patterns: [/\bMICROSOFT\b/, /\bMSFT\b/] },
  { id: "github", displayName: "GitHub", category: "software", patterns: [/\bGITHUB\b/] },
  { id: "openai", displayName: "OpenAI", category: "software", patterns: [/\bOPENAI\b/, /\bCHATGPT\b/] },
  { id: "dropbox", displayName: "Dropbox", category: "cloud_storage", patterns: [/\bDROPBOX\b/] },
  // --- Fitness ---
  { id: "planet_fitness", displayName: "Planet Fitness", category: "fitness", patterns: [/\bPLANET FITNESS\b/, /\bPLANET FIT\b/] },
  { id: "peloton", displayName: "Peloton", category: "fitness", patterns: [/\bPELOTON\b/] },
  { id: "equinox", displayName: "Equinox", category: "fitness", patterns: [/\bEQUINOX\b/] },
  // --- Insurance (required category) ---
  { id: "geico", displayName: "GEICO", category: "insurance", patterns: [/\bGEICO\b/] },
  { id: "state_farm", displayName: "State Farm", category: "insurance", patterns: [/\bSTATE FARM\b/] },
  { id: "progressive", displayName: "Progressive", category: "insurance", patterns: [/\bPROGRESSIVE\b/] },
  // --- Transportation / fuel ---
  { id: "exxon", displayName: "Exxon", category: "transportation", patterns: [/\bEXXON\b/, /\bEXXONMOBIL\b/] },
  { id: "mobil", displayName: "Mobil", category: "transportation", patterns: [/\bMOBIL\b/] },
  // --- Medical / pharmacy ---
  { id: "rite_aid", displayName: "Rite Aid", category: "medical", patterns: [/\bRITE AID\b/] },
  // --- Travel ---
  { id: "american_airlines", displayName: "American Airlines", category: "travel", patterns: [/\bAMERICAN AIRLINES\b/, /\bAMERICAN AIR\b/] },
  { id: "jetblue", displayName: "JetBlue", category: "travel", patterns: [/\bJETBLUE\b/] },
  { id: "hilton", displayName: "Hilton", category: "travel", patterns: [/\bHILTON\b/] },
  { id: "expedia", displayName: "Expedia", category: "travel", patterns: [/\bEXPEDIA\b/] },
  { id: "hertz", displayName: "Hertz", category: "travel", patterns: [/\bHERTZ\b/] },
];

const PROCESSOR_RULES = [
  { id: "paypal", displayName: "PayPal", pattern: /\b(PAYPAL|PP)\b/ },
  { id: "square", displayName: "Square", pattern: /\b(SQUARE|SQ)\b/ },
  { id: "stripe", displayName: "Stripe", pattern: /\bSTRIPE\b/ },
  { id: "shop_pay", displayName: "Shop Pay", pattern: /\bSHOP PAY\b/ },
  { id: "apple_app_store", displayName: "Apple App Store", pattern: /\b(APPLE COM BILL|APL ITUNES|ITUNES COM BILL)\b/ },
  { id: "google", displayName: "Google", pattern: /\bGOOGLE\b/ },
];

const CATEGORY_IDS = new Set(Object.keys(CATEGORY_TAXONOMY));

export function normalizeTransactionLabels(input: {
  merchantName: string;
  originalDescription?: string;
  rawCategory?: string;
  amountCents: number;
}): NormalizedStatementTransaction {
  const merchantSource = compactWhitespace(input.merchantName);
  const originalDescription = compactWhitespace(input.originalDescription ?? "");
  const rawCategoryText = compactWhitespace(input.rawCategory ?? "");
  const merchantCanonical = canonicalMerchantText(merchantSource || originalDescription);
  const descriptionCanonical = canonicalMerchantText(originalDescription);
  const searchText = normalizeSearchText([merchantSource, originalDescription, rawCategoryText].join(" "));
  const aliasText = compactWhitespace(`${merchantCanonical} ${descriptionCanonical}`);
  const alias = findMerchantAlias(aliasText);
  const rawCategory = normalizeRawCategory(rawCategoryText);
  const transferCategory = inferTransferCategory(searchText, rawCategory);
  const category = transferCategory ?? chooseCategory(rawCategory, alias?.category) ?? inferCategory(searchText);
  const flowType = inferFlowType(searchText, category, input.amountCents);
  const processor = findProcessor(aliasText || searchText);
  const unknownMerchant = isUnknownMerchant(merchantCanonical, searchText);
  const transferMerchant = transferCategory ? inferTransferMerchant(searchText, transferCategory) : undefined;
  const merchantAmbiguity = Boolean(alias?.ambiguousProcessor) || Boolean(processor && !alias) || unknownMerchant;
  const normalizedMerchantId =
    transferMerchant?.id ?? alias?.id ?? processor?.id ?? (unknownMerchant ? "unknown_merchant" : merchantKey(merchantCanonical));
  const merchantName =
    transferMerchant?.displayName ??
    alias?.displayName ??
    processor?.displayName ??
    (unknownMerchant ? "Unknown merchant" : undefined) ??
    displayMerchantName(merchantSource || originalDescription);
  const categoryMetadata = getCategoryMetadata(category);
  const uncertaintyCodes = buildUncertaintyCodes({
    category,
    flowType,
    merchantAmbiguity,
    transferCategory,
    unknownMerchant,
  });
  const confidence = confidenceFor({ category, flowType, merchantAmbiguity, unknownMerchant, aliasMatched: Boolean(alias) });

  return {
    merchantName,
    normalizedMerchantId,
    merchantCanonical: alias ? normalizeSearchText(alias.displayName) : merchantCanonical,
    merchantAmbiguity,
    category,
    categoryDisplayName: categoryMetadata.displayName,
    categoryRequiredDefault: categoryMetadata.requiredDefault,
    flowType,
    confidence,
    confidenceReason: confidenceReason(uncertaintyCodes),
    uncertaintyCodes,
  };
}

export function normalizeStatementTransaction(input: {
  merchantName: string;
  originalDescription?: string;
  rawCategory?: string;
  amountCents: number;
}): NormalizedStatementTransaction {
  return normalizeTransactionLabels(input);
}

export function getCategoryMetadata(category: string): CategoryMetadata {
  if (CATEGORY_IDS.has(category)) {
    const categoryId = category as NormalizedCategoryId;
    const metadata = CATEGORY_TAXONOMY[categoryId];
    return {
      category: categoryId,
      displayName: metadata.displayName,
      requiredDefault: metadata.requiredDefault,
    };
  }

  return {
    category: "unknown",
    displayName: CATEGORY_TAXONOMY.unknown.displayName,
    requiredDefault: CATEGORY_TAXONOMY.unknown.requiredDefault,
  };
}

export function categoryRequiredByDefault(category: string): boolean {
  return getCategoryMetadata(category).requiredDefault;
}

export function merchantKeyFromText(merchantName: string): string {
  const canonical = canonicalMerchantText(merchantName);
  return merchantKey(canonical);
}

function findMerchantAlias(canonicalText: string): MerchantAliasRule | undefined {
  return MERCHANT_ALIAS_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(canonicalText)));
}

function findProcessor(canonicalText: string): { id: string; displayName: string } | undefined {
  return PROCESSOR_RULES.find((rule) => rule.pattern.test(canonicalText));
}

function normalizeRawCategory(rawCategory: string): NormalizedCategoryId | undefined {
  const normalized = normalizeCategoryText(rawCategory);
  if (!normalized) return undefined;
  // Try the full text first, then progressively shorter prefixes. Plaid PFC
  // `detailed` codes are always prefixed by their `primary` (e.g.
  // GENERAL_MERCHANDISE_DISCOUNT_STORES → GENERAL_MERCHANDISE), so dropping
  // trailing tokens recovers the primary mapping when the detailed code is
  // unmapped — the raw `detailed` value is no longer discarded. Longest match
  // wins, so a detailed row pinned to a different category than its primary
  // still takes precedence. H-036.
  const tokens = normalized.split(" ").filter(Boolean);
  for (let end = tokens.length; end > 0; end -= 1) {
    const candidate = tokens.slice(0, end).join(" ");
    const alias = CATEGORY_ALIASES[candidate];
    if (alias === "refund_marker") {
      // Only the whole string being a refund marker means "not a real category".
      // A shorter refund-ish prefix of a longer code shouldn't swallow it.
      if (end === tokens.length) return undefined;
      continue;
    }
    if (alias) return alias;
    const asId = candidate.replace(/\s+/g, "_");
    if (CATEGORY_IDS.has(asId)) return asId as NormalizedCategoryId;
  }
  return undefined;
}

function chooseCategory(
  rawCategory: NormalizedCategoryId | undefined,
  aliasCategory: NormalizedCategoryId | undefined,
): NormalizedCategoryId | undefined {
  if (!rawCategory) return aliasCategory;
  if (!aliasCategory) return rawCategory;
  if (rawCategory === aliasCategory) return rawCategory;
  if (rawCategory === "entertainment" && ["streaming", "music_audio"].includes(aliasCategory)) {
    return aliasCategory;
  }
  if (rawCategory === "shopping" && ["software", "cloud_storage", "fitness"].includes(aliasCategory)) {
    return aliasCategory;
  }
  return rawCategory;
}

function inferTransferCategory(
  text: string,
  rawCategory: NormalizedCategoryId | undefined,
): NormalizedCategoryId | undefined {
  if (rawCategory === "credit_card_payment" || isCreditCardPaymentLike(text)) return "credit_card_payment";
  if (rawCategory === "savings_transfer" || /\b(SAVINGS|BROKERAGE|INVESTMENT|ALLY|VANGUARD|FIDELITY)\b/.test(text)) {
    if (isTransferLike(text, rawCategory)) return "savings_transfer";
  }
  if (rawCategory === "debt_payment") return "debt_payment";
  if (isTransferLike(text, rawCategory)) return "transfer";
  return undefined;
}

function inferCategory(text: string): NormalizedCategoryId {
  if (/\b(PAYROLL|SALARY|DIRECT DEPOSIT|ACH CREDIT|INTEREST|INTRST|DIVIDEND)\b/.test(text)) return "income";
  if (/\b(OVERDRAFT|MONTHLY SERVICE FEE|MAINTENANCE FEE|ATM FEE|LATE FEE|BANK FEE)\b/.test(text)) return "fees";
  if (/\b(ATM WITHDRAWAL|CASH WITHDRAWAL|WITHDRAWAL)\b/.test(text)) return "cash";
  if (/\b(RENT|MORTGAGE|APARTMENT|APARTMENTS|LANDLORD)\b/.test(text)) return "housing";
  if (/\b(COMED|ELECTRIC|GAS BILL|WATER BILL|UTILITY|UTILITIES|VERIZON|INTERNET|PHONE)\b/.test(text)) {
    return "utilities";
  }
  if (/\b(WHOLE FOODS|WHOLEFDS|TRADER JOE|JEWEL|KROGER|SAFEWAY|GROCERY|GROCERIES|SUPERMARKET)\b/.test(text)) {
    return "groceries";
  }
  if (/\b(STARBUCKS|COFFEE|BLUE BOTTLE|CAFE)\b/.test(text)) return "coffee_snacks";
  if (/\b(RESTAURANT|DINER|TACO|PIZZA|BURGER|DOORDASH|UBEREATS|UBER EATS|GRUBHUB|DELI)\b/.test(text)) {
    return "dining";
  }
  if (/\b(AIRLINE|SOUTHWEST|DELTA|UNITED AIR|AMERICAN AIRLINES|HOTEL|AIRBNB|FLIGHT|TRAVEL|MARRIOTT|HILTON)\b/.test(text)) {
    return "travel";
  }
  if (/\b(UBER|LYFT|SHELL|CHEVRON|EXXON|GAS STATION|TRANSIT|TRAIN|PARKING)\b/.test(text)) {
    return "transportation";
  }
  if (/\b(NETFLIX|HULU|DISNEY|HBO|MAX|STREAMING|APPLE TV)\b/.test(text)) return "streaming";
  if (/\b(SPOTIFY|APPLE MUSIC|MUSIC|AUDIBLE)\b/.test(text)) return "music_audio";
  if (/\b(ICLOUD|GOOGLE ONE|CLOUD STORAGE|DROPBOX|ONEDRIVE)\b/.test(text)) return "cloud_storage";
  if (/\b(ADOBE|SOFTWARE|GITHUB|NOTION|MICROSOFT 365|APP STORE|ITUNES)\b/.test(text)) return "software";
  if (/\b(GYM|FITNESS|PELOTON|PLANET FITNESS|LA FITNESS)\b/.test(text)) return "fitness";
  if (/\b(CLINIC|DOCTOR|MEDICAL|PHARMACY|CVS|WALGREENS)\b/.test(text)) return "medical";
  if (/\b(BOOKSTORE|TUITION|SCHOOL|EDUCATION|UNIVERSITY)\b/.test(text)) return "education";
  if (/\b(AMAZON|AMZN|TARGET|WALMART|COSTCO|STORE|MARKETPLACE|SHOPPING)\b/.test(text)) return "shopping";
  return "unknown";
}

function inferFlowType(text: string, category: NormalizedCategoryId, amountCents: number): FlowType {
  if (amountCents === 0) return "UNCLASSIFIED";
  if (isTransferLike(text, category)) return "UNCLASSIFIED";
  if (amountCents > 0 && /\b(REFUND|RETURN|REVERSAL|CASHBACK|CHARGEBACK|CREDIT)\b/.test(text)) return "REFUND";
  if (amountCents < 0 && (category === "fees" || /\b(FEE|OVERDRAFT|ATM FEE|LATE FEE)\b/.test(text))) return "FEE";
  if (amountCents > 0 && (category === "income" || /\b(PAYROLL|SALARY|DEPOSIT|INTEREST|ACH CREDIT)\b/.test(text))) {
    return "INCOME";
  }
  if (amountCents > 0) return "INCOME";
  return "SPEND";
}

function inferTransferMerchant(
  text: string,
  category: NormalizedCategoryId,
): { id: string; displayName: string } | undefined {
  if (category === "credit_card_payment") return { id: "credit_card_payment", displayName: "Credit card payment" };
  if (category === "savings_transfer") return { id: "internal_savings_transfer", displayName: "Savings transfer" };
  if (category === "debt_payment") return { id: "debt_payment", displayName: "Debt payment" };
  if (/\bVENMO\b/.test(text)) return { id: "venmo_transfer", displayName: "Venmo Transfer" };
  if (/\bZELLE\b/.test(text)) return { id: "zelle_transfer", displayName: "Zelle Transfer" };
  if (/\bCASH APP\b/.test(text)) return { id: "cash_app_transfer", displayName: "Cash App Transfer" };
  return undefined;
}

function isTransferLike(text: string, category: NormalizedCategoryId | undefined): boolean {
  return (
    category === "transfer" ||
    category === "savings_transfer" ||
    category === "credit_card_payment" ||
    category === "debt_payment" ||
    isCreditCardPaymentLike(text) ||
    /\b(TRANSFER|XFER|ZELLE|VENMO|CASH APP|ACH TRANSFER|ONLINE TRANSFER|ACCOUNT TRANSFER|WIRE TRANSFER|PAYMENT TO|PAYMENT FROM|AUTOPAY)\b/.test(
      text,
    )
  );
}

function isCreditCardPaymentLike(text: string): boolean {
  return /\b(CREDIT CARD PAYMENT|CARD PAYMENT|CC PAYMENT|CC PYMT|AUTO PAYMENT|AUTOMATIC PAYMENT|AUTOPAY|PAYMENT TO (CHASE|AMERICAN EXPRESS|AMEX|CITI|CAPITAL ONE|DISCOVER|WELLS FARGO|BANK OF AMERICA)|PAYMENT FROM .*CHECKING)\b/.test(
    text,
  );
}

function canonicalMerchantText(value: string): string {
  return normalizeSearchText(value)
    .replace(/\b(POS|DEBIT|ACH|CARD|CHECKCARD|TST|SQ)\b/g, " ")
    .replace(/\b(LLC|INC|CO|LTD|CORP|CORPORATION)\b/g, " ")
    .replace(/\b(STORE|TERM|TERMINAL|AUTH|TRACE|REF)\b\s*\d+\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(/\b\d{2,}\b/g, " ")
    .replace(/\b(USA|US)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value: string): string {
  return compactWhitespace(value)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategoryText(value: string): string {
  return normalizeSearchText(value).toLowerCase();
}

function merchantKey(canonical: string): string {
  const key = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return key || "unknown_merchant";
}

function displayMerchantName(value: string): string {
  const cleaned = compactWhitespace(value);
  if (!cleaned || /^unknown merchant$/i.test(cleaned)) return "Unknown merchant";
  return cleaned;
}

function isUnknownMerchant(merchantCanonical: string, searchText: string): boolean {
  if (!merchantCanonical) return true;
  return /^(UNKNOWN|UNKNOWN MERCHANT|MERCHANT|PURCHASE|DEBIT PURCHASE|CARD PURCHASE|DEBIT CARD PURCHASE|POS PURCHASE|TRANSACTION)$/.test(
    merchantCanonical || searchText,
  );
}

function buildUncertaintyCodes(input: {
  category: NormalizedCategoryId;
  flowType: FlowType;
  merchantAmbiguity: boolean;
  transferCategory: NormalizedCategoryId | undefined;
  unknownMerchant: boolean;
}): NormalizationUncertaintyCode[] {
  const codes: NormalizationUncertaintyCode[] = [];
  if (input.unknownMerchant) codes.push("unknown_merchant");
  if (input.merchantAmbiguity && !input.unknownMerchant) codes.push("ambiguous_processor");
  if (input.category === "unknown") codes.push("unknown_category");
  if (input.flowType === "UNCLASSIFIED" && input.transferCategory) codes.push("transfer_like_unpaired");
  return codes;
}

function confidenceFor(input: {
  category: NormalizedCategoryId;
  flowType: FlowType;
  merchantAmbiguity: boolean;
  unknownMerchant: boolean;
  aliasMatched: boolean;
}): number {
  let confidence = input.aliasMatched ? 0.95 : 0.9;
  if (input.category === "unknown") confidence = Math.min(confidence, 0.55);
  if (input.merchantAmbiguity) confidence = Math.min(confidence, 0.7);
  if (input.unknownMerchant) confidence = Math.min(confidence, 0.55);
  if (input.flowType === "UNCLASSIFIED") confidence = Math.min(confidence, 0.6);
  return confidence;
}

function confidenceReason(codes: NormalizationUncertaintyCode[]): string {
  if (codes.includes("transfer_like_unpaired")) {
    return "Transfer-like statement text needs backend account matching before it can be treated as internal movement.";
  }
  if (codes.includes("unknown_merchant") || codes.includes("unknown_category")) {
    return "Statement row lacked enough merchant or category evidence for a precise normalization.";
  }
  if (codes.includes("ambiguous_processor")) {
    return "Statement row names a processor or app store without enough evidence for the underlying merchant.";
  }
  return "Deterministic merchant and category normalization.";
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
