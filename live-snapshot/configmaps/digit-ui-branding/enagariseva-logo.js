(function () {
  var LOGO_SRC = "/digit-ui/enagariseva-logo.png?v=1";
  var LOGO_CLASS = "enagariseva-logo";
  // Employee header ends with img.state; citizen header ends with img#topbar-logo inside RightMostTopBarOptions.
  var ANCHORS = [".topbar img.state", ".RightMostTopBarOptions > img#topbar-logo"];

  function addStyle() {
    if (document.getElementById("enagariseva-logo-style")) return;
    var style = document.createElement("style");
    style.id = "enagariseva-logo-style";
    style.textContent =
      "img." + LOGO_CLASS + "{box-sizing:content-box;height:30px;width:auto;max-width:none;" +
      "padding:3px 6px;margin-left:10px;background:#fff;border:1px solid #e0e0e0;border-radius:4px;" +
      "box-shadow:0 1px 2px rgba(0,0,0,.12);align-self:center;vertical-align:middle;" +
      "object-fit:contain;flex-shrink:0;}" +
      "@media (max-width:660px){img." + LOGO_CLASS + "{height:22px;padding:2px 4px;margin-left:6px;}}";
    (document.head || document.documentElement).appendChild(style);
  }

  function attach() {
    ANCHORS.forEach(function (selector) {
      var anchors = document.querySelectorAll(selector);
      for (var i = 0; i < anchors.length; i++) {
        var anchor = anchors[i];
        var next = anchor.nextElementSibling;
        if (next && next.classList && next.classList.contains(LOGO_CLASS)) continue;
        var img = document.createElement("img");
        img.className = LOGO_CLASS;
        img.src = LOGO_SRC;
        img.alt = "e-Nagarisewa";
        img.decoding = "async";
        anchor.insertAdjacentElement("afterend", img);
      }
    });
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      attach();
    });
  }

  function start() {
    addStyle();
    attach();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
