/**
 * JSON Viewer – background script
 *
 * Content scripts are not allowed to call browser.runtime.sendNativeMessage
 * (Apple limitation), so this page relays the one native request we need:
 *
 *   content script --runtime.sendMessage--> background --sendNativeMessage-->
 *   SafariWebExtensionHandler (Swift) --CoreText--> every installed
 *   monospace font family, back to the font picker.
 */
(function () {
  'use strict';

  var api =
    typeof browser !== 'undefined' && browser && browser.runtime ? browser
      : typeof chrome !== 'undefined' && chrome && chrome.runtime ? chrome
      : null;

  if (!api || !api.runtime || !api.runtime.onMessage) return;

  // Safari ignores this id and routes to the containing app's native handler;
  // it is kept for Chrome-compatible call semantics.
  var APP_ID = 'cn.oxzz.json-viewer';

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'jv-system-fonts') return false;

    var settled = false;
    function reply(payload) {
      if (settled) return;
      settled = true;
      try { sendResponse(payload); } catch (e) { /* ignore */ }
    }
    function fontsOf(resp) {
      return resp && Array.isArray(resp.fonts) ? { fonts: resp.fonts } : null;
    }

    if (typeof api.runtime.sendNativeMessage !== 'function') { reply(null); return false; }

    try {
      var r = api.runtime.sendNativeMessage(
        APP_ID,
        { action: 'listMonospaceFonts' },
        function (resp) { reply(fontsOf(resp)); }
      );
      if (r && typeof r.then === 'function') r.then(function (resp) { reply(fontsOf(resp)); },
        function () { reply(null); });
    } catch (e) { reply(null); }

    setTimeout(function () { reply(null); }, 5000);
    return true; // keep the message channel open for the async sendResponse
  });
})();
