/**
 * The operator's legal pages (RECALL_LEGAL_URL): where the dashboard links to them, and the
 * version of the Terms of Service and DPA that sign-ups, Checkout and auto top-up record.
 */

/** Version printed at the top of public/terms.html and public/dpa.html (a test keeps them equal). */
export const TERMS_VERSION = "2.1";

export interface LegalLinks {
  terms: string;
  privacy: string;
  dpa: string;
  security: string;
  support: string;
  /** The model withdrawal form for consumers (terms section 10). */
  withdrawalForm: string;
}

export function legalLinks(origin: string): LegalLinks {
  const base = origin.replace(/\/+$/, "");
  return {
    terms: `${base}/terms`,
    privacy: `${base}/privacy`,
    dpa: `${base}/dpa`,
    security: `${base}/security`,
    support: `${base}/support`,
    withdrawalForm: `${base}/terms#withdrawal-form`,
  };
}

/** Printed on every top-up invoice and in the purchase email (the durable-medium confirmation). */
export function withdrawalNotice(l: LegalLinks): string {
  return `You asked Recall to make this credit available immediately. If you are a consumer, you may withdraw from this purchase within 14 days and get back what you paid for the credit you have not used: email support@recallmem.dev or use the model withdrawal form at ${l.withdrawalForm}. Terms of Service (version ${TERMS_VERSION}): ${l.terms}`;
}
