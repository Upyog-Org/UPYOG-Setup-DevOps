(function () {
  if (window.__upyogPtErrorPatchV8) return;
  window.__upyogPtErrorPatchV8 = true;

  function getUser() {
    try {
      if (window.Digit && Digit.UserService && Digit.UserService.getUser) {
        var u = Digit.UserService.getUser();
        if (u) return u;
      }
    } catch (e) {}
    try {
      var raw = sessionStorage.getItem("Digit.User");
      if (!raw) return null;
      var item = JSON.parse(raw);
      return item && item.value ? item.value : null;
    } catch (e) {
      return null;
    }
  }

  function saveErr(msg) {
    try {
      var s = String(msg || "").slice(0, 6000);
      if (!s || s.indexOf("[UPYOG_LAST_ERROR]") === 0) return;
      sessionStorage.setItem("UPYOG_LAST_ERROR", s);
      sessionStorage.setItem("UPYOG_LAST_ERROR_AT", String(Date.now()));
    } catch (e) {}
  }

  function showBanner(text) {
    function paint() {
      try {
        var el = document.getElementById("upyog-error-banner");
        if (!el) {
          el = document.createElement("div");
          el.id = "upyog-error-banner";
          el.style.cssText =
            "position:fixed;z-index:2147483647;left:0;right:0;top:0;background:#7a1010;color:#fff;padding:14px 16px;font:13px/1.45 Consolas,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto";
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = text;
      } catch (e) {}
    }
    if (document.body) paint();
    else document.addEventListener("DOMContentLoaded", paint);
  }

  // Only inject userInfo on _fetchbill ???????? do NOT touch history/location (that left Assess blank)
  try {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__upyogUrl = String(url || "");
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (
          this.__upyogUrl &&
          this.__upyogUrl.indexOf("_fetchbill") !== -1 &&
          typeof body === "string" &&
          body.charAt(0) === "{"
        ) {
          var data = JSON.parse(body);
          data.RequestInfo = data.RequestInfo || { apiId: "Rainmaker" };
          var user = getUser();
          if (user) {
            if (!data.RequestInfo.userInfo && user.info) data.RequestInfo.userInfo = user.info;
            if (!data.RequestInfo.authToken && user.access_token) data.RequestInfo.authToken = user.access_token;
          }
          if (!data.RequestInfo.userInfo) {
            data.RequestInfo.userInfo = {
              type: "EMPLOYEE",
              tenantId: "pg.citya",
              roles: [{ code: "PT_CEMP", tenantId: "pg.citya" }],
            };
          }
          body = JSON.stringify(data);
        }
      } catch (e) {}
      return _send.call(this, body);
    };
  } catch (e) {}

  function patchFetchBill() {
    try {
      if (!window.Digit || !Digit.PaymentService || !Digit.PaymentService.fetchBill || Digit.PaymentService.fetchBill.__upyogV8) return;
      var orig = Digit.PaymentService.fetchBill.bind(Digit.PaymentService);
      Digit.PaymentService.fetchBill = function () {
        return orig.apply(null, arguments).catch(function (err) {
          saveErr("fetchBill soft-fail: " + ((err && err.message) || err));
          return { Bill: [] };
        });
      };
      Digit.PaymentService.fetchBill.__upyogV8 = true;
    } catch (e) {}
  }
  patchFetchBill();
  setTimeout(patchFetchBill, 800);
  setTimeout(patchFetchBill, 2500);

  // Capture React errors for banner, but do not block navigation
  try {
    var _log = console.log.bind(console);
    console.log = function () {
      try {
        var a0 = arguments[0];
        var a1 = arguments[1];
        if (typeof a0 === "string" && /getDerivedStateFromError|componentDidCatch/i.test(a0)) {
          var text = a0 + "\n" + ((a1 && (a1.stack || a1.message)) || "");
          saveErr(text);
          showBanner("REAL ASSESS ERROR:\n" + text);
        }
      } catch (e) {}
      return _log.apply(console, arguments);
    };
  } catch (e) {}

  window.addEventListener("error", function (e) {
    saveErr((e.error && e.error.stack) || e.message);
  });

  try {
    if (String(location.href).indexOf("/user/error") !== -1) {
      var saved = sessionStorage.getItem("UPYOG_LAST_ERROR");
      if (saved) showBanner("REAL ASSESS ERROR:\n" + saved);
    }
  } catch (e) {}
})();
