(function () {
  if (window.__ptTakeActionV10) return;
  window.__ptTakeActionV10 = true;

  function cityTenant() {
    try {
      if (window.Digit && Digit.ULBService && Digit.ULBService.getCurrentTenantId) {
        var id = Digit.ULBService.getCurrentTenantId();
        if (id && String(id).indexOf(".") !== -1) return id;
      }
    } catch (e) {}
    return "pg.citya";
  }

  function sessionUser() {
    try {
      return (Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || {};
    } catch (e) {
      return {};
    }
  }

  function userRoleCodes() {
    var info = sessionUser().info || {};
    return (info.roles || [])
      .map(function (r) {
        return typeof r === "string" ? r : r && r.code;
      })
      .filter(Boolean);
  }

  function isAck(id) {
    id = String(id || "");
    return id.indexOf("-AC-") !== -1 || id.indexOf("-MT-") !== -1 || id.indexOf("-AS-") !== -1;
  }

  function businessServiceFor(moduleCode, property) {
    var code = String(moduleCode || "");
    if (code.indexOf("PT.") === 0) return code;
    var reason = property && String(property.creationReason || "").toUpperCase();
    if (reason === "MUTATION") return "PT.MUTATION";
    if (reason === "UPDATE" || reason === "PT.UPDATE") return "PT.UPDATE";
    return "PT.CREATE";
  }

  function fallbackActions(stateName, businessService) {
    var state = String(stateName || "").toUpperCase();
    var bs = String(businessService || "");
    if (state === "DOCVERIFIED") return [{ action: "FORWARD", roles: ["PT_FIELD_INSPECTOR"] }];
    if (state === "FIELDVERIFIED") {
      if (bs === "PT.MUTATION") return [{ action: "PAY", roles: ["CITIZEN", "PT_CEMP"] }];
      return [
        { action: "APPROVE", roles: ["PT_APPROVER"] },
        { action: "REJECT", roles: ["PT_APPROVER"] },
      ];
    }
    if (state === "CORRECTIONPENDING") {
      return [
        { action: "REOPEN", roles: ["CITIZEN", "PT_CEMP"] },
        { action: "REJECT", roles: ["CITIZEN", "PT_CEMP"] },
      ];
    }
    if (state === "PAID") return [{ action: "APPROVE", roles: ["PT_APPROVER"] }];
    if (state === "OPEN" || state === "INWORKFLOW" || state === "PENDINGFORASSIGNMENT") {
      return [
        { action: "VERIFY", roles: ["PT_DOC_VERIFIER"] },
        { action: "REJECT", roles: ["PT_DOC_VERIFIER"] },
        { action: "SENDBACKTOCITIZEN", roles: ["PT_DOC_VERIFIER"] },
      ];
    }
    return [];
  }

  function shapeActions(list) {
    var mine = userRoleCodes();
    return (list || [])
      .map(function (item) {
        if (!item) return null;
        var action = typeof item === "string" ? item : item.action;
        if (!action) return null;
        var roles = item.roles && item.roles.length ? item.roles.slice() : [];
        if (!roles.length) {
          var seeded = fallbackActions("", "").filter(function (a) {
            return a.action === action;
          })[0];
          roles = (seeded && seeded.roles) || [];
        }
        var needsPicker = action === "FORWARD";
        return {
          action: action,
          roles: roles,
          assigneeRoles: needsPicker ? ["PT_APPROVER"] : [],
          isTerminateState: !needsPicker,
        };
      })
      .filter(function (item) {
        if (!item) return false;
        if (!item.roles.length || !mine.length) return true;
        return item.roles.some(function (role) {
          return mine.indexOf(role) !== -1;
        });
      });
  }

  function post(url) {
    var user = sessionUser();
    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        RequestInfo: {
          apiId: "Rainmaker",
          authToken: user.access_token,
          userInfo: user.info,
          msgId: "pt-take-action",
        },
      }),
    }).then(function (res) {
      return res.json();
    });
  }

  function loadActions(tenantId, id, moduleCode) {
    var tid = tenantId || cityTenant();
    var propertyUrl =
      "/property-services/property/_search?tenantId=" +
      encodeURIComponent(tid) +
      "&" +
      (isAck(id) ? "acknowledgementIds=" : "propertyIds=") +
      encodeURIComponent(id);
    return post(propertyUrl)
      .catch(function () {
        return {};
      })
      .then(function (body) {
        var property = body && body.Properties && body.Properties[0];
        var bs = businessServiceFor(moduleCode, property);
        var ack =
          (property && (property.acknowldgementNumber || property.acknowledgementNumber)) ||
          (isAck(id) ? id : "");
        if (!ack) return { businessService: bs, actions: [] };
        return post(
          "/egov-workflow-v2/egov-wf/process/_search?tenantId=" +
            encodeURIComponent(tid) +
            "&businessIds=" +
            encodeURIComponent(ack) +
            "&history=false"
        )
          .catch(function () {
            return {};
          })
          .then(function (wf) {
            var instance = (wf && wf.ProcessInstances && wf.ProcessInstances[0]) || {};
            var stateName = (instance.state && instance.state.state) || "";
            var fromState = (instance.state && instance.state.actions) || instance.nextActions || [];
            var actions = fromState.length ? fromState : fallbackActions(stateName, instance.businessService || bs);
            return {
              businessService: instance.businessService || bs,
              actions: actions,
              processInstances: instance.businessId ? [instance] : [],
            };
          });
      });
  }

  function withActions(details, loaded) {
    var actions = shapeActions(loaded.actions);
    var next = Object.assign({}, details || {});
    next.timeline = Array.isArray(next.timeline) ? next.timeline : [];
    next.nextActions = actions;
    next.actionState = Object.assign({}, next.actionState || {}, { nextActions: actions });
    next.applicationBusinessService = loaded.businessService || next.applicationBusinessService;
    next.processInstances = loaded.processInstances || next.processInstances || [];
    return next;
  }

  function isPtCall(args) {
    var code = String((args && args.moduleCode) || "");
    var path = (window.location && window.location.pathname) || "";
    return code.indexOf("PT") === 0 || path.indexOf("/pt/") !== -1;
  }

  function installWorkflow() {
    var svc = window.Digit && Digit.WorkflowService;
    if (!svc || typeof svc.getDetailsById !== "function" || svc.__ptTakeActionV10) return !!svc;
    svc.__ptTakeActionV10 = true;
    var orig = svc.getDetailsById.bind(svc);
    svc.getDetailsById = function (args) {
      var run = Promise.resolve()
        .then(function () {
          return orig(args);
        })
        .catch(function () {
          return {};
        });
      if (!isPtCall(args)) return run;
      return Promise.all([
        run,
        loadActions(args && args.tenantId, args && args.id, args && args.moduleCode),
      ]).then(function (pair) {
        return withActions(pair[0], pair[1]);
      });
    };
    return true;
  }

  // Collect Payment stuck: _fetchbill DuplicateKeyException / wrong tenant → empty Bill → infinite spinner.
  // Force city tenant and fall back to bill/_search when fetchbill fails or returns empty.
  function searchPtBill(tid, consumerCode, businessService) {
    var user = sessionUser();
    var qs =
      "tenantId=" +
      encodeURIComponent(tid) +
      "&consumerCode=" +
      encodeURIComponent(consumerCode) +
      "&service=" +
      encodeURIComponent(businessService || "PT");
    return fetch("/billing-service/bill/v2/_search?" + qs, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        RequestInfo: {
          apiId: "Rainmaker",
          authToken: user.access_token,
          userInfo: user.info,
          msgId: "pt-collect-fix|en_IN",
        },
      }),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (j) {
        var bills = (j && (j.Bill || j.Bills)) || [];
        return { Bill: Array.isArray(bills) ? bills : [] };
      })
      .catch(function () {
        return { Bill: [] };
      });
  }

  function installCollectBillFix() {
    var ps = window.Digit && Digit.PaymentService;
    if (!ps || typeof ps.fetchBill !== "function" || ps.__ptCollectFixV5) return !!ps;
    ps.__ptCollectFixV5 = true;
    var origFetch = ps.fetchBill.bind(ps);
    ps.fetchBill = function (tenantId, filters) {
      var f = Object.assign({}, filters || {});
      var tid = tenantId && String(tenantId).indexOf(".") !== -1 ? tenantId : cityTenant();
      if (f.consumerCode && String(f.consumerCode).indexOf("PG-PT-") === 0) tid = cityTenant();
      if (f.businessService && String(f.businessService).indexOf("PT") === 0) tid = cityTenant();
      return Promise.resolve(origFetch(tid, f))
        .then(function (res) {
          if (res && Array.isArray(res.Bill) && res.Bill.length) return res;
          if (!f.consumerCode) return res || { Bill: [] };
          return searchPtBill(tid, f.consumerCode, f.businessService || f.service || "PT").then(function (s) {
            return s.Bill && s.Bill.length ? s : res || { Bill: [] };
          });
        })
        .catch(function () {
          if (!f.consumerCode) return { Bill: [] };
          return searchPtBill(tid, f.consumerCode, f.businessService || f.service || "PT");
        });
    };
    return true;
  }

  // City A only — never fall back to state tenant "pg" for filestore/receipts.
  function fileStorePublicUrl(_tenantId, id) {
    return (
      "/filestore/v1/files/id?tenantId=" +
      encodeURIComponent(cityTenant()) +
      "&fileStoreId=" +
      encodeURIComponent(id)
    );
  }

  function fileExistsAtCity(id) {
    if (!id) return Promise.resolve(false);
    return fetch(fileStorePublicUrl(cityTenant(), id), { method: "GET", credentials: "include" })
      .then(function (r) {
        return r.ok;
      })
      .catch(function () {
        return false;
      });
  }

  function isInternalMinioUrl(url) {
    var u = String(url || "");
    return u.indexOf("minio.backbone") !== -1 || /:\/\/minio(\.|:)/i.test(u);
  }

  function payRequestInfo() {
    var session = sessionUser();
    return {
      apiId: "Rainmaker",
      ver: ".01",
      ts: "",
      action: "_search",
      did: "1",
      key: "",
      msgId: Date.now() + "|en_IN",
      authToken: session.access_token,
      userInfo: session.info,
    };
  }

  function searchPtPayments(tenantId, consumerCode, receiptNo) {
    var qs = "tenantId=" + encodeURIComponent(tenantId);
    if (receiptNo) qs += "&receiptNumbers=" + encodeURIComponent(receiptNo);
    else if (consumerCode) qs += "&consumerCodes=" + encodeURIComponent(consumerCode);
    var body = JSON.stringify({ RequestInfo: payRequestInfo() });
    var urls = [
      "/collection-services/payments/_search?" + qs,
      "/collection-services/payments/PT/_search?" + qs,
    ];
    function next(i) {
      if (i >= urls.length) return Promise.resolve([]);
      return fetch(urls[i], {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body,
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { http: r.status, json: j };
          });
        })
        .then(function (out) {
          var pays = out && out.json && (out.json.Payments || out.json.payments);
          if (out && out.http < 300 && pays && pays.length) return pays;
          return next(i + 1);
        })
        .catch(function () {
          return next(i + 1);
        });
    }
    return next(0);
  }

  function createReceiptPdf(tenantId, payments) {
    var keys = ["property-receipt", "consolidatedreceipt", "pt-receipt"];
    function next(i) {
      if (i >= keys.length) return Promise.reject(new Error("pdf_failed"));
      return fetch(
        "/pdf-service/v1/_create?key=" +
          encodeURIComponent(keys[i]) +
          "&tenantId=" +
          encodeURIComponent(tenantId),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ RequestInfo: payRequestInfo(), Payments: payments }),
        }
      )
        .then(function (r) {
          return r.json().then(function (j) {
            return { http: r.status, json: j };
          });
        })
        .then(function (out) {
          var ids = (out && out.json && (out.json.filestoreIds || out.json.fileStoreIds)) || [];
          if (out && out.http < 300 && ids[0]) return ids[0];
          return next(i + 1);
        })
        .catch(function () {
          return next(i + 1);
        });
    }
    return next(0);
  }

  function downloadPtReceipt(consumerCode, tenantId, receiptNo) {
    // Always City A — ignore state-level "pg" even if caller passes it.
    tenantId = cityTenant();
    return searchPtPayments(tenantId, consumerCode, receiptNo).then(function (payments) {
      if (!payments || !payments.length) {
        window.alert("No receipt found for this payment.");
        return { status: 404, data: null };
      }
      var existing = payments[0] && payments[0].fileStoreId;
      if (!existing && payments[0] && payments[0].paymentDetails && payments[0].paymentDetails[0]) {
        existing = payments[0].paymentDetails[0].fileStoreId;
      }
      // Old receipts may be stored under "pg"; re-create under pg.citya when missing.
      var ready = fileExistsAtCity(existing).then(function (ok) {
        if (ok) return existing;
        return createReceiptPdf(tenantId, payments);
      });
      return ready
        .then(function (id) {
          if (!id) {
            window.alert("Could not generate receipt PDF. Try again.");
            return { status: 502, data: null };
          }
          window.open(fileStorePublicUrl(tenantId, id), "_blank");
          return { status: 200, data: new Blob() };
        })
        .catch(function () {
          window.alert("Could not generate receipt PDF. Try again.");
          return { status: 502, data: null };
        });
    });
  }

  function receiptArgsFromLocation() {
    try {
      var path = (window.location && window.location.pathname) || "";
      // /employee/payment/success/PT/<receipt>/<consumerCode>
      var m = path.match(/\/payment\/success\/[^/]+\/([^/]+)\/([^/?#]+)/i);
      if (!m) return null;
      return {
        receiptNo: decodeURIComponent(m[1]),
        consumerCode: decodeURIComponent(m[2]),
      };
    } catch (e) {
      return null;
    }
  }

  function installReceiptPrintFix() {
    if (!window.Digit) return false;
    if (Digit.Utils && !Digit.Utils.__ptReceiptHookV5) {
      Digit.Utils.__ptReceiptHookV5 = true;
      Digit.Utils.downloadReceipt = function (consumerCode, _bs, _key, tenantId, receiptNo) {
        return downloadPtReceipt(consumerCode, tenantId, receiptNo);
      };
    }
    if (Digit.ReceiptsService && !Digit.ReceiptsService.__ptReceiptHookV5) {
      Digit.ReceiptsService.__ptReceiptHookV5 = true;
      Digit.ReceiptsService.receipt_download = function (bs, consumerCode, tenantId, _key, receiptNo) {
        return downloadPtReceipt(consumerCode, tenantId, receiptNo);
      };
    }
    if (Digit.PaymentService && typeof Digit.PaymentService.printReciept === "function" && !Digit.PaymentService.__ptPrintSafeV5) {
      Digit.PaymentService.__ptPrintSafeV5 = true;
      Digit.PaymentService.printReciept = function (tenantId, params) {
        var fromPage = receiptArgsFromLocation() || {};
        var consumer =
          (params && (params.consumerCode || params.consumerCodes)) || fromPage.consumerCode || "";
        var receiptNo =
          (params && (params.receiptNumber || params.receiptNumbers)) || fromPage.receiptNo || "";
        return downloadPtReceipt(consumer, cityTenant(), receiptNo).then(function () {
          return {};
        });
      };
    }
    if (!window.__ptOpenMinioFixV5) {
      window.__ptOpenMinioFixV5 = true;
      var origOpen = window.open.bind(window);
      window.open = function (url, target, features) {
        if (isInternalMinioUrl(url)) {
          var fromPage = receiptArgsFromLocation();
          if (fromPage && fromPage.consumerCode) {
            downloadPtReceipt(fromPage.consumerCode, cityTenant(), fromPage.receiptNo);
            return null;
          }
          // Last resort: route through filestore if fileStoreId is in the query
          try {
            var parsed = new URL(String(url), window.location.origin);
            var fsId = parsed.searchParams.get("fileStoreId");
            if (fsId) return origOpen(fileStorePublicUrl(cityTenant(), fsId), target, features);
          } catch (e) {}
          if (fromPage) {
            downloadPtReceipt(fromPage.consumerCode, cityTenant(), fromPage.receiptNo);
            return null;
          }
        }
        return origOpen(url, target, features);
      };
    }
    return !!(Digit.PaymentService || Digit.Utils);
  }

  function normalizeOwnershipCategory(oc, owners) {
    var code = "";
    if (typeof oc === "string") code = oc;
    else if (oc && typeof oc === "object") code = oc.code || oc.value || "";
    code = String(code || "");
    if (!code) code = "INDIVIDUAL.SINGLEOWNER";
    // Digit's nextStep keys are INDIVIDUAL.SINGLEOWNER / INDIVIDUAL.MULTIPLEOWNERS, not bare INDIVIDUAL.
    if (code === "INDIVIDUAL") {
      var n = Array.isArray(owners) ? owners.filter(Boolean).length : 1;
      code = n > 1 ? "INDIVIDUAL.MULTIPLEOWNERS" : "INDIVIDUAL.SINGLEOWNER";
    }
    return { code: code, value: code, i18nKey: "PT_OWNERSHIP_" + (code.split(".")[1] || code) };
  }

  function usageMajorFromCode(usage) {
    var parts = String(usage || "RESIDENTIAL").split(".");
    var major = parts[0] || "RESIDENTIAL";
    // ProvideSubUsageType matches i18nKey.split("_")[3] to usageCategory.code.split(".")[1]
    var minor = parts[1] || major;
    return {
      code: major === "NONRESIDENTIAL" && parts[1] ? major + "." + parts[1] : major,
      i18nKey: "PROPERTYTAX_BILLING_SLAB_" + minor,
    };
  }

  function isResidentialUsage(fd) {
    var c =
      (fd.usageCategoryMajor && fd.usageCategoryMajor.code) ||
      fd.usageCategory ||
      (fd.units && fd.units[0] && fd.units[0].usageCategory) ||
      "";
    c = String(c);
    return !c || c === "RESIDENTIAL" || c.indexOf("RESIDENTIAL") === 0;
  }

  // Digit PTCheckPage crashes on A.documents.proofIdentity when documents is missing/array.
  function sanitizePtCheckFormValue(value) {
    var v = Object.assign({}, value || {});
    v.units = Array.isArray(v.units) && v.units.length ? v.units : [{}];
    if (v.ownershipCategory && typeof v.ownershipCategory === "string") {
      v.ownershipCategory = normalizeOwnershipCategory(v.ownershipCategory, v.owners);
    } else if (v.ownershipCategory && typeof v.ownershipCategory === "object") {
      v.ownershipCategory = normalizeOwnershipCategory(v.ownershipCategory, v.owners);
    } else {
      v.ownershipCategory = normalizeOwnershipCategory("INDIVIDUAL.SINGLEOWNER", v.owners);
    }
    v.address = Object.assign({}, v.address || {});
    v.address.locality = Object.assign({ code: "NA", name: "NA" }, v.address.locality || {});
    if (!v.address.locality.code) v.address.locality.code = "NA";
    v.address.city = Object.assign({ code: cityTenant(), name: "City A" }, v.address.city || {});
    if (!v.address.city.code) v.address.city.code = cityTenant();
    if (!v.address.documents || typeof v.address.documents !== "object") v.address.documents = {};
    if (!v.address.documents.ProofOfAddress) {
      v.address.documents.ProofOfAddress = { name: "na", fileStoreId: "NA", documentType: "ADDRESSPROOF" };
    }
    var owners = Array.isArray(v.owners) ? v.owners : [];
    if (!owners.length) owners = [{}];
    v.owners = owners.map(function (o) {
      o = Object.assign({}, o || {});
      o.gender = o.gender && typeof o.gender === "object" ? o.gender : { code: o.gender || "MALE" };
      o.relationship =
        o.relationship && typeof o.relationship === "object" ? o.relationship : { code: o.relationship || "FATHER" };
      o.ownerType = o.ownerType && typeof o.ownerType === "object" ? o.ownerType : { code: o.ownerType || "NONE" };
      var docs = o.documents;
      var proof = null;
      var special = null;
      if (docs && typeof docs === "object" && !Array.isArray(docs)) {
        proof = docs.proofIdentity || null;
        special = docs.specialProofIdentity || null;
      } else if (Array.isArray(docs)) {
        docs.forEach(function (d) {
          if (!d) return;
          var dt = typeof d.documentType === "string" ? d.documentType : (d.documentType && d.documentType.code) || "";
          if (String(dt).indexOf("IDENTITYPROOF") !== -1) proof = d;
          if (String(dt).indexOf("SPECIALCATEGORYPROOF") !== -1) special = d;
        });
      }
      if (!proof) proof = { name: "na", fileStoreId: "NA", documentType: "OWNER.IDENTITYPROOF.AADHAAR" };
      if (proof && !proof.name) proof.name = proof.fileStoreId || "na";
      o.documents = { proofIdentity: proof };
      if (special) o.documents.specialProofIdentity = special;
      return o;
    });
    return v;
  }

  // PT.UPDATE: fix ownership nextStep routeKey, undefined URLs, empty sub-usage, check-page crash.
  function installPtUpdateFlowFix() {
    var reg = window.Digit && Digit.ComponentRegistryService;
    var React = window.React;
    if (!reg || typeof reg.getComponent !== "function" || !React) return false;
    if (reg.__ptUpdateFlowV10) return true;
    reg.__ptUpdateFlowV10 = true;
    var origGet = reg.getComponent.bind(reg);
    var wraps = {};

    function wrapSelectOwnerShip(C) {
      return function SelectOwnerShipDetailsUpdateSafe(props) {
        var next = Object.assign({}, props || {});
        var fd = Object.assign({}, next.formData || {});
        var path = "";
        try {
          path = (window.location && window.location.pathname) || "";
        } catch (e) {}
        if (path.indexOf("/edit-application/") !== -1 || path.indexOf("/modify-application/") !== -1) {
          var norm = normalizeOwnershipCategory(fd.ownershipCategory, fd.owners);
          fd.ownershipCategory = norm;
          try {
            sessionStorage.setItem("ownershipCategory", norm.value);
          } catch (e2) {}
          next.formData = fd;
        }
        return React.createElement(C, next);
      };
    }

    function wrapProvideSubUsage(C) {
      return function ProvideSubUsageTypeUpdateSafe(props) {
        var next = Object.assign({}, props || {});
        var fd = Object.assign({}, next.formData || {});
        var usage =
          (fd.usageCategoryMajor && fd.usageCategoryMajor.code) ||
          fd.usageCategory ||
          (fd.units && fd.units[0] && fd.units[0].usageCategory) ||
          "RESIDENTIAL";
        fd.usageCategoryMajor = usageMajorFromCode(usage);
        next.formData = fd;

        var residential = isResidentialUsage(fd);
        React.useEffect(
          function () {
            if (!residential) return;
            try {
              sessionStorage.setItem("subusagetypevar", "yes");
            } catch (e) {}
            var Q = String((window.location.href || "").split("/").pop() || "");
            var dummy = { i18nKey: "COMMON_PROPSUBUSGTYPE_RESIDENTIAL", code: "RESIDENTIAL" };
            var onSelect = props.onSelect;
            var config = props.config || {};
            if (typeof onSelect !== "function") return;
            if (isNaN(Number(Q)) && Q !== "0" && Q !== "-1") {
              onSelect("subusagetype", { SubUsageType: dummy, subuagecode: "RESIDENTIAL" });
            } else {
              var unit = (fd.units && fd.units[Q]) || {};
              onSelect(
                config.key || "units",
                Object.assign({}, unit, { SubUsageType: dummy, subuagecode: "RESIDENTIAL" }),
                false,
                Q
              );
            }
          },
          [residential]
        );

        if (residential) {
          return React.createElement(
            "div",
            { style: { padding: "16px", color: "#505a5f", font: '14px/1.4 "Noto Sans",sans-serif' } },
            "Residential property — sub-usage step is not required. Continuing…"
          );
        }
        return React.createElement(C, next);
      };
    }

    function wrapCheckPage(C) {
      return function PTCheckPageSafe(props) {
        var next = Object.assign({}, props || {});
        try {
          next.value = sanitizePtCheckFormValue(next.value || next.formData || {});
        } catch (e) {
          next.value = sanitizePtCheckFormValue({});
        }
        try {
          return React.createElement(C, next);
        } catch (err) {
          return React.createElement(
            "div",
            { style: { padding: 16 } },
            "Could not render summary. Go Back and retry, or use a property with complete owner documents."
          );
        }
      };
    }

    reg.getComponent = function (name) {
      var C = origGet(name);
      if (!C) return C;
      if (name === "SelectOwnerShipDetails") {
        if (!wraps[name]) wraps[name] = wrapSelectOwnerShip(C);
        return wraps[name];
      }
      if (name === "ProvideSubUsageType" || name === "ProvideSubUsageTypeOfRentedArea") {
        if (!wraps[name]) wraps[name] = wrapProvideSubUsage(C);
        return wraps[name];
      }
      if (name === "PTCheckPage" || name === "CheckPage") {
        if (!wraps[name]) wraps[name] = wrapCheckPage(C);
        return wraps[name];
      }
      return C;
    };

    if (!window.__ptUpdateHistV10 && window.history && History && History.prototype) {
      window.__ptUpdateHistV10 = true;
      function fixUndefinedUrl(url) {
        if (url == null) return url;
        var u = String(url);
        if (u.indexOf("/undefined") === -1) return url;
        // Broken nextStep lookup → /edit-application/undefined[/index]
        if (u.indexOf("/edit-application/") !== -1) {
          u = u.replace(/\/undefined(?=\/|$)/g, "/owner-details");
        } else {
          u = u.replace(/\/undefined(?=\/|$)/g, "");
        }
        return u;
      }
      var origPush = History.prototype.pushState;
      History.prototype.pushState = function (state, title, url) {
        return origPush.call(this, state, title, fixUndefinedUrl(url));
      };
      var origReplace = History.prototype.replaceState;
      History.prototype.replaceState = function (state, title, url) {
        return origReplace.call(this, state, title, fixUndefinedUrl(url));
      };
      try {
        if (String(window.location.pathname || "").indexOf("/undefined") !== -1) {
          var fixed = fixUndefinedUrl(window.location.pathname + (window.location.search || ""));
          origReplace.call(window.history, window.history.state, "", fixed);
        }
      } catch (eFix) {}
    }
    return true;
  }

  // Edit/Update keeps ownership radios disabled — make that obvious (Digit custom radios look active).
  function installOwnershipDisabledLook() {
    if (window.__ptOwnerShipDisabledLookV10) return true;
    window.__ptOwnerShipDisabledLookV10 = true;
    if (!document.getElementById("upyog-pt-ownership-disabled-css")) {
      var style = document.createElement("style");
      style.id = "upyog-pt-ownership-disabled-css";
      style.textContent =
        "body.upyog-pt-ownership-readonly .radio-wrap," +
        "body.upyog-pt-ownership-readonly .radio-wrap label," +
        "body.upyog-pt-ownership-readonly .radio-btn-wrap{" +
        "opacity:0.55;cursor:not-allowed;pointer-events:none;}" +
        "body.upyog-pt-ownership-readonly .radio-btn-checkmark{" +
        "border-color:#b1b4b6 !important;background:#f3f2f1 !important;}" +
        "body.upyog-pt-ownership-readonly .radio-btn:checked + .radio-btn-checkmark," +
        "body.upyog-pt-ownership-readonly .radio-btn:checked ~ .radio-btn-checkmark{" +
        "border-color:#b1b4b6 !important;}" +
        "#upyog-pt-ownership-readonly-note{" +
        "margin:0 0 12px;padding:10px 12px;background:#f3f2f1;border-left:4px solid #505a5f;" +
        "color:#505a5f;font:14px/1.4 \"Noto Sans\",sans-serif;}";
      (document.head || document.documentElement).appendChild(style);
    }
    function paint() {
      try {
        var path = (window.location && window.location.pathname) || "";
        var onEditOwnership =
          path.indexOf("owner-ship-details") !== -1 &&
          (path.indexOf("/edit-application/") !== -1 || path.indexOf("/modify-application/") !== -1);
        document.body.classList.toggle("upyog-pt-ownership-readonly", onEditOwnership);
        var note = document.getElementById("upyog-pt-ownership-readonly-note");
        if (!onEditOwnership) {
          if (note && note.parentNode) note.parentNode.removeChild(note);
          return;
        }
        if (!note) {
          note = document.createElement("div");
          note.id = "upyog-pt-ownership-readonly-note";
          note.textContent =
            "Ownership type cannot be changed in Edit Property (read-only). Use Transfer Ownership / Mutation to change owners.";
        }
        var host =
          document.querySelector(".form-section") ||
          document.querySelector("form") ||
          document.querySelector(".card") ||
          document.querySelector("main") ||
          document.body;
        if (note.parentNode !== host) {
          if (host.firstChild) host.insertBefore(note, host.firstChild);
          else host.appendChild(note);
        }
        // Keep Next working: Digit nextStep needs INDIVIDUAL.SINGLEOWNER, not bare INDIVIDUAL.
        try {
          var cur = sessionStorage.getItem("ownershipCategory") || "";
          if (!cur || cur === "INDIVIDUAL") {
            sessionStorage.setItem("ownershipCategory", "INDIVIDUAL.SINGLEOWNER");
          }
        } catch (eSs) {}
        document.querySelectorAll(".radio-wrap input.radio-btn").forEach(function (el) {
          el.disabled = true;
          el.setAttribute("disabled", "disabled");
        });
      } catch (e) {}
    }
    setInterval(paint, 400);
    paint();
    try {
      window.addEventListener("popstate", paint);
    } catch (e) {}
    return true;
  }

  function install() {
    var a = installWorkflow();
    var b = installCollectBillFix();
    var c = installReceiptPrintFix();
    var d = installOwnershipDisabledLook();
    var e = installPtUpdateFlowFix();
    return a && b && c && d && e;
  }

  var timer = setInterval(function () {
    if (install()) clearInterval(timer);
  }, 200);
  install();
})();
