/**
 * Where a chat or a project was started, from the request that made it. Every request from away comes through remote-access.mjs, which
 * sets x-strata-remote (and removes one sent from outside); every app names itself with x-strata-client ("ios" for the iPhone app, "ui"
 * for Strata's web page).
 *
 *   ios-app      the iPhone app
 *   remote-web   Strata's web page, opened from away (another computer, a phone's browser)
 *   pc           Strata's window or web page on this PC
 *   remote-api   another program from away
 *   local-api    another program on this PC (a script, the Terminal)
 */
export function originOf(req, at = new Date()) {
  const remote = req.headers['x-strata-remote'] === '1';
  const client = req.headers['x-strata-client'];
  const via = client === 'ios' ? 'ios-app' : client === 'ui' ? (remote ? 'remote-web' : 'pc') : remote ? 'remote-api' : 'local-api';
  return { via, at: at.toISOString() };
}
