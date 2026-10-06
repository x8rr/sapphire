// Per-extension web-compat interventions, in the spirit of browsers' site
// interventions. Sapphire keeps one consistent URL scheme (the https alias
// origin) for getURL, location, sender.url and tab.url, which is what the vast
// majority of extensions rely on (they compare these against each other).
// A few hard-code the literal "chrome-extension://" and need a nudge.

export interface ExtensionCompat {
  /** Report sender.url of extension pages as chrome-extension://<id>/... (origin stays the alias origin). */
  senderUrlAsChromeExtension?: boolean;
}

const TABLE: Record<string, ExtensionCompat> = {
  // Tampermonkey: `sender.url.indexOf("chrome-extension://") === 0 && sender.origin === location.origin`
  dhdgffkkebhmkfjojejmpbldmpobfkfo: { senderUrlAsChromeExtension: true },
};

export function compatFor(extId: string): ExtensionCompat {
  return TABLE[extId] ?? {};
}
