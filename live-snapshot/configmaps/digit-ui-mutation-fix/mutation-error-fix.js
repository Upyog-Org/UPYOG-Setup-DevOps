(function () {
  if (window.__upyogMutationFixV6) return;
  window.__upyogMutationFixV6 = true;

  function softBill(res) {
    if (!res || typeof res !== "object") return { Bill: [] };
    if (!Array.isArray(res.Bill)) res.Bill = [];
    return res;
  }

  function saveErr(msg) {
    try {
      var s = String(msg || "").slice(0, 8000);
      if (!s) return;
      sessionStorage.setItem("UPYOG_LAST_ERROR", s);
      sessionStorage.setItem("UPYOG_LAST_ERROR_AT", String(Date.now()));
    } catch (e) {}
  }

  function showBanner(text) {
    function paint() {
      try {
        var el = document.getElementById("upyog-mutation-error-banner");
        if (!el) {
          el = document.createElement("div");
          el.id = "upyog-mutation-error-banner";
          el.style.cssText =
            "position:fixed;z-index:2147483647;left:0;right:0;bottom:0;background:#7a1010;color:#fff;padding:12px 16px;font:12px/1.4 Consolas,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto";
          (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = text;
      } catch (e) {}
    }
    if (document.body) paint();
    else document.addEventListener("DOMContentLoaded", paint);
  }

  function errToText(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    return (err.stack || err.message || String(err)) + "";
  }

  // Capture React ErrorBoundary logs BEFORE full-page redirect to /user/error
  try {
    var _log = console.log.bind(console);
    console.log = function () {
      try {
        var a0 = arguments[0];
        var a1 = arguments[1];
        if (typeof a0 === "string" && /getDerivedStateFromError|componentDidCatch|Redircter/i.test(a0)) {
          saveErr(a0 + "\n" + errToText(a1));
        }
        if (a0 && (a0.stack || a0.message) && /TypeError|Cannot read|undefined/i.test(String(a0.message || a0.stack || ""))) {
          saveErr(errToText(a0));
        }
      } catch (e) {}
      return _log.apply(console, arguments);
    };
  } catch (e) {}

  try {
    var _error = console.error.bind(console);
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(errToText(arguments[i]));
        var joined = parts.join("\n");
        if (/TypeError|Cannot read|undefined|null|Payments|ownerType|ownershipCategory/i.test(joined)) saveErr(joined);
      } catch (e) {}
      return _error.apply(console, arguments);
    };
  } catch (e) {}

  // Intercept full-page redirect used by ErrorBoundary Redircter
  try {
    var desc = Object.getOwnPropertyDescriptor(Location.prototype, "href") ||
      Object.getOwnPropertyDescriptor(window.location.__proto__, "href");
    if (desc && desc.set) {
      var rawSet = desc.set;
      Object.defineProperty(window.location, "href", {
        configurable: true,
        enumerable: true,
        get: desc.get ? function () { return desc.get.call(window.location); } : function () { return String(window.location); },
        set: function (v) {
          try {
            if (String(v).indexOf("/user/error") !== -1) {
              var existing = sessionStorage.getItem("UPYOG_LAST_ERROR");
              if (!existing) saveErr("Redirect to /user/error with no prior stack. href=" + v);
            }
          } catch (e) {}
          return rawSet.call(window.location, v);
        },
      });
    }
  } catch (e) {}

  window.addEventListener("error", function (ev) {
    try {
      saveErr(errToText(ev && ev.error) || (ev && ev.message));
    } catch (e) {}
  });

  window.addEventListener("unhandledrejection", function (ev) {
    try {
      saveErr(errToText(ev && ev.reason));
    } catch (e) {}
  });

  function patchPaymentService() {
    try {
      if (!window.Digit || !Digit.PaymentService || Digit.PaymentService.__upyogMutationPatchedV5) {
        return !!Digit.PaymentService && !!Digit.PaymentService.__upyogMutationPatchedV5;
      }
      var origSearch = Digit.PaymentService.searchBill;
      if (typeof origSearch === "function") {
        Digit.PaymentService.searchBill = function () {
          return Promise.resolve(origSearch.apply(Digit.PaymentService, arguments))
            .then(softBill)
            .catch(function (err) {
              saveErr(errToText(err));
              return { Bill: [] };
            });
        };
      }
      var origFetch = Digit.PaymentService.fetchBill;
      if (typeof origFetch === "function") {
        Digit.PaymentService.fetchBill = function () {
          return Promise.resolve(origFetch.apply(Digit.PaymentService, arguments))
            .then(softBill)
            .catch(function (err) {
              saveErr(errToText(err));
              return { Bill: [] };
            });
        };
      }
      // Soft-wrap receipt search used by mutation details download options
      if (typeof Digit.PaymentService.searchReciept === "function" && !Digit.PaymentService.searchReciept.__upyogV5) {
        var origRec = Digit.PaymentService.searchReciept.bind(Digit.PaymentService);
        Digit.PaymentService.searchReciept = function () {
          return Promise.resolve(origRec.apply(null, arguments))
            .then(function (res) {
              if (!res || typeof res !== "object") return { Payments: [] };
              if (!Array.isArray(res.Payments)) res.Payments = [];
              return res;
            })
            .catch(function (err) {
              saveErr(errToText(err));
              return { Payments: [] };
            });
        };
        Digit.PaymentService.searchReciept.__upyogV5 = true;
      }
      Digit.PaymentService.__upyogMutationPatchedV5 = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function patchPtCalculate() {
    try {
      if (!window.Digit || !Digit.PTService || !Digit.PTService.ptCalculateMutation || Digit.PTService.__upyogMutationPatchedV5) {
        return !!Digit.PTService && !!Digit.PTService.__upyogMutationPatchedV5;
      }
      var orig = Digit.PTService.ptCalculateMutation;
      Digit.PTService.ptCalculateMutation = function (payload) {
        if (!payload || !payload.Property) return Promise.resolve({});
        return Promise.resolve(orig.apply(Digit.PTService, arguments)).catch(function (err) {
          saveErr(errToText(err));
          return {};
        });
      };
      Digit.PTService.__upyogMutationPatchedV5 = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  try {
    if (String(location.href).indexOf("/user/error") !== -1) {
      var saved = sessionStorage.getItem("UPYOG_LAST_ERROR");
      if (saved) showBanner("MUTATION/PT CRASH:\n" + saved);
      else showBanner("MUTATION/PT CRASH: no stack captured yet. Hard-refresh, open mutation again, then return here.");
    }
  } catch (e) {}

  function boot() {
    patchPaymentService();
    patchPtCalculate();
  }
  boot();
  var n = 0;
  var iv = setInterval(function () {
    n++;
    boot();
    if (n > 80) clearInterval(iv);
  }, 400);

  console.info("[mutation-fix] v6 loaded (timeline processInstances/nextActions)");
})();
