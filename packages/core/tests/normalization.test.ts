import { describe, expect, it } from "vitest";
import normalizationFixture from "../fixtures/mvp0/merchant-normalization-cases.json";
import {
  getCategoryMetadata,
  normalizeTransactionLabels,
  summarizeMonthlySpending,
} from "../src";
import type { Account, Transaction } from "../src";

type NormalizationFixture = {
  cases: {
    name: string;
    input: {
      merchantName: string;
      originalDescription?: string;
      rawCategory?: string;
      amountCents: number;
    };
    expected: Record<string, unknown>;
  }[];
  crossAccountBehavior: {
    transactions: {
      accountId: string;
      merchantName: string;
      originalDescription?: string;
      rawCategory?: string;
      amountCents: number;
    }[];
    expected: {
      normalizedMerchantId: string;
      category: string;
      merchantTransactionCount: number;
      merchantOutflowCents: number;
      checkingOutflowCents: number;
      creditCardOutflowCents: number;
    };
  };
};

const fixture = normalizationFixture as NormalizationFixture;

describe("transaction label normalization", () => {
  it("normalizes noisy merchant aliases and categories deterministically", () => {
    for (const example of fixture.cases) {
      expect(normalizeTransactionLabels(example.input), example.name).toMatchObject(example.expected);
    }
  });

  it("keeps unknown and ambiguous merchants uncertain instead of inventing precision", () => {
    const paypal = normalizeTransactionLabels(caseInput("ambiguous_processor_without_underlying_merchant"));
    const unknown = normalizeTransactionLabels(caseInput("unknown_card_purchase"));

    expect(paypal).toMatchObject({
      normalizedMerchantId: "paypal",
      merchantAmbiguity: true,
      uncertaintyCodes: ["ambiguous_processor"],
    });
    expect(paypal.confidence).toBeLessThanOrEqual(0.7);
    expect(unknown).toMatchObject({
      normalizedMerchantId: "unknown_merchant",
      category: "unknown",
      uncertaintyCodes: ["unknown_merchant", "unknown_category"],
    });
    expect(unknown.confidence).toBeLessThanOrEqual(0.55);
  });

  it("lets transfer-like and credit-card-payment text override consumer merchant aliases", () => {
    const paymentLike = normalizeTransactionLabels(caseInput("payment_like_ordinary_merchant_text"));
    const creditCardPayment = normalizeTransactionLabels(caseInput("credit_card_payment_target_text"));

    expect(paymentLike.normalizedMerchantId).toBe("netflix");
    expect(paymentLike.category).toBe("transfer");
    expect(paymentLike.flowType).toBe("UNCLASSIFIED");
    expect(creditCardPayment).toMatchObject({
      merchantName: "Credit card payment",
      normalizedMerchantId: "credit_card_payment",
      category: "credit_card_payment",
      flowType: "UNCLASSIFIED",
    });
  });

  it("exposes backend-owned category display metadata", () => {
    expect(getCategoryMetadata("coffee_snacks")).toEqual({
      category: "coffee_snacks",
      displayName: "Coffee and snacks",
      requiredDefault: false,
    });
    expect(getCategoryMetadata("debt_payment")).toEqual({
      category: "debt_payment",
      displayName: "Debt payment",
      requiredDefault: true,
    });
    expect(getCategoryMetadata("not_in_taxonomy")).toEqual({
      category: "unknown",
      displayName: "Unknown",
      requiredDefault: false,
    });
  });

  it("does not deduplicate purchases across accounts when labels match", () => {
    const transactions = fixture.crossAccountBehavior.transactions.map((input, index) =>
      normalizedTransaction(`tx_spotify_${index}`, input),
    );
    const [summary] = summarizeMonthlySpending(transactions, "USD", accounts);
    const expected = fixture.crossAccountBehavior.expected;
    const merchant = summary.merchantTotals.find((total) => total.normalizedMerchantId === expected.normalizedMerchantId);
    const category = summary.categoryTotals.find((total) => total.category === expected.category);

    expect(summary.totalOutflowCents).toBe(expected.merchantOutflowCents);
    expect(merchant).toMatchObject({
      normalizedMerchantId: expected.normalizedMerchantId,
      displayName: "Spotify",
      outflowCents: expected.merchantOutflowCents,
      transactionCount: expected.merchantTransactionCount,
    });
    expect(category).toMatchObject({
      category: expected.category,
      displayName: "Music and audio",
      outflowCents: expected.merchantOutflowCents,
      transactionCount: expected.merchantTransactionCount,
    });
    expect(summary.accountTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "account_local_checking", totalOutflowCents: expected.checkingOutflowCents }),
        expect.objectContaining({ id: "account_amex_gold", totalOutflowCents: expected.creditCardOutflowCents }),
      ]),
    );
  });

  it("carries merchant ambiguity into merchant spending totals", () => {
    const transaction = normalizedTransaction("tx_paypal_unknown", caseInput("ambiguous_processor_without_underlying_merchant"));
    const [summary] = summarizeMonthlySpending([transaction], "USD", accounts);

    expect(summary.merchantTotals).toEqual([
      expect.objectContaining({
        normalizedMerchantId: "paypal",
        merchantAmbiguity: true,
        ambiguousTransactionCount: 1,
        unknownTransactionCount: 0,
      }),
    ]);
  });
});

describe("H-036: Plaid sandbox unknown-bucket categorization", () => {
  it("maps the sandbox default-stream merchants to real categories", () => {
    expect(normalizeTransactionLabels({ merchantName: "Madison Bicycle Shop", amountCents: -50000 })).toMatchObject({
      merchantName: "Madison Bicycle Shop",
      category: "shopping",
    });
    expect(normalizeTransactionLabels({ merchantName: "SparkFun", amountCents: -8946 })).toMatchObject({
      merchantName: "SparkFun",
      category: "shopping",
    });
    expect(normalizeTransactionLabels({ merchantName: "Tectra Inc", amountCents: -50000 })).toMatchObject({
      merchantName: "Tectra",
      category: "shopping",
    });
    expect(normalizeTransactionLabels({ merchantName: "Touchstone Climbing", amountCents: -7850 })).toMatchObject({
      merchantName: "Touchstone Climbing",
      category: "fitness",
    });
  });

  it("treats the credit-card auto-payment as a transfer, not spend", () => {
    const autopay = normalizeTransactionLabels({
      merchantName: "",
      originalDescription: "AUTOMATIC PAYMENT - THANK YOU",
      amountCents: -1454950,
    });
    expect(autopay.category).toBe("credit_card_payment");
    expect(autopay.flowType).toBe("UNCLASSIFIED");
  });

  it("recognizes the INTRST interest abbreviation as income", () => {
    const interest = normalizeTransactionLabels({
      merchantName: "",
      originalDescription: "INTRST PYMNT",
      amountCents: 844,
    });
    expect(interest.category).toBe("income");
    expect(interest.flowType).toBe("INCOME");
  });

  it("keeps the glued GUSTO ACH out of spend as a transfer", () => {
    const gusto = normalizeTransactionLabels({
      merchantName: "",
      originalDescription: "ACH Electronic CreditGUSTO PAY 123456",
      amountCents: -1170000,
    });
    expect(gusto.category).toBe("transfer");
    expect(gusto.flowType).toBe("UNCLASSIFIED");
  });

  it("resolves Plaid PFC detailed codes, falling back to the primary when a detailed code is unmapped", () => {
    // Explicitly-pinned detailed codes.
    expect(normalizeTransactionLabels({ merchantName: "Some Lender", rawCategory: "LOAN_PAYMENTS_CAR_PAYMENT", amountCents: -40000 }).category).toBe("debt_payment");
    expect(normalizeTransactionLabels({ merchantName: "Some Lender", rawCategory: "LOAN_PAYMENTS_MORTGAGE", amountCents: -150000 }).category).toBe("housing");
    expect(normalizeTransactionLabels({ merchantName: "Corner Shop", rawCategory: "HOME_IMPROVEMENT_HARDWARE_STORES", amountCents: -6000 }).category).toBe("shopping");
    // Unmapped detailed code recovers via its primary prefix (GENERAL_MERCHANDISE).
    expect(normalizeTransactionLabels({ merchantName: "Neutral Vendor Q", rawCategory: "GENERAL_MERCHANDISE_CONVENIENCE_STORES", amountCents: -1200 }).category).toBe("shopping");
  });
});

describe("L-008: Plaid PFC taxonomy breadth", () => {
  const category = (rawCategory: string, merchantName = "Neutral Vendor", amountCents = -5000) =>
    normalizeTransactionLabels({ merchantName, rawCategory, amountCents }).category;

  it("labels the RENT_AND_UTILITIES primary as utilities so bills stop landing in Housing", () => {
    // Before L-008 the RENT_AND_UTILITIES primary was unmapped, so every detailed
    // code under it (internet, electric, water, gas...) fell through to the "rent"
    // keyword -> housing. Only the literal RENT detailed code should be housing.
    expect(category("RENT_AND_UTILITIES_INTERNET_AND_CABLE")).toBe("utilities");
    expect(category("RENT_AND_UTILITIES_GAS_AND_ELECTRICITY")).toBe("utilities");
    expect(category("RENT_AND_UTILITIES_WATER")).toBe("utilities");
    expect(category("RENT_AND_UTILITIES_TELEPHONE")).toBe("utilities");
    expect(category("RENT_AND_UTILITIES_RENT")).toBe("housing");
  });

  it("pins detailed codes whose category differs from their primary (longest-match wins)", () => {
    expect(category("PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS")).toBe("fitness");
    expect(category("GENERAL_SERVICES_CHILDCARE")).toBe("childcare");
    expect(category("GENERAL_SERVICES_EDUCATION")).toBe("education");
    expect(category("GENERAL_SERVICES_INSURANCE")).toBe("insurance");
    expect(category("GENERAL_SERVICES_AUTOMOTIVE")).toBe("transportation");
    expect(category("ENTERTAINMENT_TV_AND_MOVIES")).toBe("streaming");
    expect(category("ENTERTAINMENT_MUSIC_AND_AUDIO")).toBe("music_audio");
  });

  it("routes credit-card and savings movements out of spend via UNCLASSIFIED flow", () => {
    const creditCard = normalizeTransactionLabels({ merchantName: "Nationwide Bank", rawCategory: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", amountCents: -50000 });
    expect(creditCard.category).toBe("credit_card_payment");
    expect(creditCard.flowType).toBe("UNCLASSIFIED");

    const savings = normalizeTransactionLabels({ merchantName: "Ally Bank Savings", rawCategory: "TRANSFER_OUT_SAVINGS", amountCents: -30000 });
    expect(savings.category).toBe("savings_transfer");
    expect(savings.flowType).toBe("UNCLASSIFIED");

    const brokerage = normalizeTransactionLabels({ merchantName: "Vanguard", rawCategory: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", amountCents: -100000 });
    expect(brokerage.category).toBe("savings_transfer");
    expect(brokerage.flowType).toBe("UNCLASSIFIED");
  });

  it("lets an unmapped detailed code recover through its mapped primary prefix", () => {
    // These detailed codes are intentionally NOT pinned; they should inherit the
    // primary bucket rather than fall to unknown. (GENERAL_SERVICES primary maps
    // to shopping today; the point is that it resolves, not to unknown.)
    expect(category("ENTERTAINMENT_VIDEO_GAMES")).toBe("entertainment");
    expect(category("GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING")).toBe("shopping");
  });
});

describe("L-008: common US merchant coverage", () => {
  // Each row is a realistic statement descriptor (store numbers included, since
  // canonicalization strips them) paired with the merchant name and category the
  // pipeline must produce. These exercise the CSV path a real bank export takes:
  // no rawCategory, so only the merchant regex + keyword net classify the row.
  const cases: [descriptor: string, merchantName: string, category: string][] = [
    ["MCDONALDS 1234", "McDonald's", "dining"],
    ["CHIPOTLE 0456 ORDER", "Chipotle", "dining"],
    ["CHICK-FIL-A #01123", "Chick-fil-A", "dining"],
    ["TACO BELL 5567", "Taco Bell", "dining"],
    ["WENDY'S 8890", "Wendy's", "dining"],
    ["PANERA BREAD 2201", "Panera Bread", "dining"],
    ["DOMINO'S PIZZA 3345", "Domino's", "dining"],
    ["GRUBHUB FOODORDER", "Grubhub", "dining"],
    ["SWEETGREEN 0099", "Sweetgreen", "dining"],
    ["PANDA EXPRESS 7712", "Panda Express", "dining"],
    ["DUNKIN #339021", "Dunkin'", "coffee_snacks"],
    ["DUTCH BROS 0031", "Dutch Bros", "coffee_snacks"],
    ["SAFEWAY #1122", "Safeway", "groceries"],
    ["ALDI 62201", "Aldi", "groceries"],
    ["PUBLIX SUPER MARKET", "Publix", "groceries"],
    ["INSTACART 8843", "Instacart", "groceries"],
    ["SAM'S CLUB #4412", "Sam's Club", "shopping"],
    ["BEST BUY 00119", "Best Buy", "shopping"],
    ["THE HOME DEPOT 6612", "The Home Depot", "shopping"],
    ["LOWE'S #0231", "Lowe's", "shopping"],
    ["IKEA 0092", "IKEA", "shopping"],
    ["EBAY O0119923", "eBay", "shopping"],
    ["NIKE 0031", "Nike", "shopping"],
    ["AT&T BILL PAYMENT", "AT&T", "utilities"],
    ["T-MOBILE 8899", "T-Mobile", "utilities"],
    ["COMCAST XFINITY 3312", "Xfinity", "utilities"],
    ["SPECTRUM 4451", "Spectrum", "utilities"],
    ["HBO MAX 1102", "Max", "streaming"],
    ["PEACOCK PREMIUM", "Peacock", "streaming"],
    ["PARAMOUNT+ 0021", "Paramount+", "streaming"],
    ["GOOGLE YOUTUBE PREMIUM", "YouTube", "streaming"],
    ["MICROSOFT 8801", "Microsoft", "software"],
    ["GITHUB 0021", "GitHub", "software"],
    ["OPENAI CHATGPT SUBSCR", "OpenAI", "software"],
    ["DROPBOX 0091", "Dropbox", "cloud_storage"],
    ["PLANET FITNESS 3312", "Planet Fitness", "fitness"],
    ["PELOTON 0021", "Peloton", "fitness"],
    ["EQUINOX 0099", "Equinox", "fitness"],
    ["GEICO AUTO INSURANCE", "GEICO", "insurance"],
    ["STATE FARM INSURANCE", "State Farm", "insurance"],
    ["PROGRESSIVE INS 0021", "Progressive", "insurance"],
    ["EXXONMOBIL 8891", "Exxon", "transportation"],
    ["MOBIL 3312", "Mobil", "transportation"],
    ["RITE AID 0091", "Rite Aid", "medical"],
    ["AMERICAN AIRLINES 0021", "American Airlines", "travel"],
    ["JETBLUE 8891", "JetBlue", "travel"],
    ["HILTON HOTELS 3312", "Hilton", "travel"],
    ["EXPEDIA 0091", "Expedia", "travel"],
    ["HERTZ RENT A CAR", "Hertz", "travel"],
  ];

  it.each(cases)("classifies %s as %s / %s", (descriptor, merchantName, category) => {
    const result = normalizeTransactionLabels({ merchantName: descriptor, amountCents: -1234 });
    expect(result, descriptor).toMatchObject({ merchantName, category });
  });

  it("keeps a genuinely unrecognized merchant in unknown rather than guessing", () => {
    const result = normalizeTransactionLabels({ merchantName: "ZORP QUANTUM WIDGETS 8891", amountCents: -1234 });
    expect(result.category).toBe("unknown");
    expect(result.uncertaintyCodes).toContain("unknown_category");
  });

  it("does not guess a category for the ambiguous SUBWAY descriptor", () => {
    // "SUBWAY" is both the sandwich chain and transit; there is deliberately no
    // rule for it, so it must stay unknown instead of being forced into dining.
    expect(normalizeTransactionLabels({ merchantName: "SUBWAY 00421", amountCents: -1200 }).category).toBe("unknown");
  });
});

function caseInput(name: string): NormalizationFixture["cases"][number]["input"] {
  const example = fixture.cases.find((candidate) => candidate.name === name);
  expect(example).toBeDefined();
  return example?.input as NormalizationFixture["cases"][number]["input"];
}

function normalizedTransaction(
  id: string,
  input: NormalizationFixture["cases"][number]["input"] & { accountId?: string },
): Transaction {
  const normalized = normalizeTransactionLabels(input);
  return {
    id,
    accountId: input.accountId ?? "account_local_checking",
    postedDate: "2026-08-15",
    merchantName: normalized.merchantName,
    originalDescription: input.originalDescription,
    amountCents: input.amountCents,
    currency: "USD",
    category: normalized.category,
    categoryDisplayName: normalized.categoryDisplayName,
    categoryRequiredDefault: normalized.categoryRequiredDefault,
    normalizedMerchantId: normalized.normalizedMerchantId,
    merchantCanonical: normalized.merchantCanonical,
    merchantAmbiguity: normalized.merchantAmbiguity,
    flowType: normalized.flowType,
    normalizationUncertaintyCodes: normalized.uncertaintyCodes,
    freshness: { status: "usable", asOf: "2026-08-15T00:00:00.000Z", source: "fixture", warnings: [] },
    uncertainty: {
      confidence: normalized.confidence,
      confidenceReason: normalized.confidenceReason,
      isEstimated: normalized.confidence < 0.9,
      estimateMethod: normalized.confidence < 0.9 ? "category_average" : undefined,
    },
    source: "fixture",
  };
}

const accounts: Account[] = [
  {
    id: "account_local_checking",
    displayName: "Local Checking",
    institutionName: "Local Bank",
    type: "checking",
    role: "spendable_cash",
    currency: "USD",
    currentBalanceCents: 100_000,
    includeInForecast: false,
    freshness: { status: "usable", asOf: "2026-08-15T00:00:00.000Z", source: "fixture", warnings: [] },
    source: "fixture",
  },
  {
    id: "account_amex_gold",
    displayName: "Amex Gold",
    institutionName: "American Express",
    type: "credit_card",
    role: "liability",
    currency: "USD",
    currentBalanceCents: -100_000,
    includeInForecast: false,
    freshness: { status: "usable", asOf: "2026-08-15T00:00:00.000Z", source: "fixture", warnings: [] },
    source: "fixture",
  },
];
