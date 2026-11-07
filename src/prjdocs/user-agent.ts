// The `User-Agent` every documentation fetch sends.
//
// The value identifies as a crawler a site already admits. A custom, unknown
// agent is refused or throttled by many documentation hosts; a named crawler
// token gets the same politeness budget those sites grant indexers. The request
// interval in `prjdocs.requestIntervalMs` still applies, and this string is
// configurable, so an operator who prefers an honest bot UA can set one.

export const DEFAULT_DOCS_USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
