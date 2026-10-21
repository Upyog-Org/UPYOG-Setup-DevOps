(function () {
  // pt-slim v72 — preserve mutation registration/court additionalDetails on employee details
  if (!Array.prototype.at) {
    Array.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    };
  }

  function hasCity(tid) {
    return !!(tid && String(tid).indexOf(".") !== -1);
  }

  function cityTenant() {
    try {
      var fromUlb = window.Digit && Digit.ULBService && Digit.ULBService.getCurrentTenantId && Digit.ULBService.getCurrentTenantId();
      var fromCity = window.Digit && Digit.SessionStorage && Digit.SessionStorage.get && Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY");
      var cityCode = fromCity && fromCity.code;
      var fromUser = window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
      var userTid = fromUser && fromUser.info && fromUser.info.tenantId;
      if (hasCity(cityCode)) return cityCode;
      if (hasCity(fromUlb)) return fromUlb;
      if (hasCity(userTid)) return userTid;
      return "pg.citya";
    } catch (e) {
      return "pg.citya";
    }
  }

  function currentUser() {
    try {
      return (window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || {};
    } catch (e) {
      return {};
    }
  }

  var ptStartUpdateCache = {};
  var ptStartUpdateInflight = {};
  // Mutation employee details (vl) re-searches by acknowledgementIds; if that response
  // is empty/thin, court + registration fields render as CS_NA. Cache real values here.
  var ptMutationAdCache = {};

  function isPtBillUrl(url) {
    var u = String(url || "");
    if (u.indexOf("_fetchbill") === -1 && u.indexOf("/demand/_search") === -1 && u.indexOf("/bill/v2/_search") === -1) return false;
    return u.indexOf("PG-PT-") !== -1 || /[?&]businessService=PT\b/.test(u) || /[?&]service=PT\b/.test(u);
  }

  function rewriteBillUrl(url) {
    var u = String(url || "");
    if (!isPtBillUrl(u)) return u;
    return u.replace(/([?&]tenantId=)pg(?=&|$|#)/g, "$1" + cityTenant());
  }

  function rewritePtSearchUrl(url) {
    var u = String(url || "");
    if (u.indexOf("/property-services/property/_search") === -1) return u;
    try {
      var parsed = new URL(u, window.location.origin);
      var isAudit = String(parsed.searchParams.get("audit") || "").toLowerCase() === "true";
      var pid = parsed.searchParams.get("propertyIds") || "";
      var ack = parsed.searchParams.get("acknowledgementIds") || "";
      // Audit + acknowledgementIds → 400 EG_PT_PROPERTY_AUDIT_ERROR (needs propertyId).
      if (isAudit && (isPtAckId(pid) || isPtAckId(ack))) {
        var realId = ptAckToPropertyId[pid] || ptAckToPropertyId[ack];
        if (!realId && !isPtAckId(pid) && pid) realId = pid;
        if (realId) {
          parsed.searchParams.set("propertyIds", realId);
          parsed.searchParams.delete("acknowledgementIds");
          return parsed.pathname + parsed.search + (parsed.hash || "");
        }
      }
      if (isPtAckId(pid) && !parsed.searchParams.get("acknowledgementIds")) {
        var mapped = ptAckToPropertyId[pid];
        if (isAudit && mapped) {
          parsed.searchParams.set("propertyIds", mapped);
        } else {
          parsed.searchParams.set("acknowledgementIds", pid);
          parsed.searchParams.delete("propertyIds");
        }
        return parsed.pathname + parsed.search + (parsed.hash || "");
      }
    } catch (e) {}
    return u;
  }

  function enrichBillRequest(body) {
    try {
      if (body == null || body === "") {
        body = "{}";
      }
      var j = typeof body === "string" ? JSON.parse(body) : body;
      if (!j || typeof j !== "object") return body;
      j.RequestInfo = j.RequestInfo || {};
      var user = currentUser();
      if (user.access_token) {
        j.RequestInfo.authToken = user.access_token;
        if (user.info) j.RequestInfo.userInfo = user.info;
      }
      if (!j.RequestInfo.apiId) j.RequestInfo.apiId = "Rainmaker";
      return JSON.stringify(j);
    } catch (e) {
      return body;
    }
  }

  function emptyPtBill(consumerCode, tid) {
    return {
      Bill: [
        {
          consumerCode: consumerCode,
          tenantId: tid,
          totalAmount: 0,
          billDetails: [],
        },
      ],
    };
  }

  function ptAuthFetchBill(tenantId, filters, attempt) {
    attempt = attempt || 0;
    var f = Object.assign({}, filters || {});
    var tid = hasCity(tenantId) ? tenantId : cityTenant();
    if (f.consumerCode && String(f.consumerCode).indexOf("PG-PT-") === 0) tid = cityTenant();
    if (f.businessService && String(f.businessService).indexOf("PT") === 0) tid = cityTenant();
    var user = currentUser();
    var token = user.access_token;
    if (!token && attempt < 6) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(ptAuthFetchBill(tenantId, filters, attempt + 1));
        }, 300);
      });
    }
    var params = Object.assign({ tenantId: tid }, f);
    var qs = Object.keys(params)
      .filter(function (k) {
        return params[k] !== undefined && params[k] !== null && params[k] !== "";
      })
      .map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      })
      .join("&");
    var body = JSON.stringify({
      RequestInfo: {
        apiId: "Rainmaker",
        ver: ".01",
        ts: Date.now(),
        action: "_fetchbill",
        did: "1",
        key: "",
        msgId: "digit-ui|en_IN",
        authToken: token || null,
        userInfo: user.info || null,
      },
    });
    var headers = { "Content-Type": "application/json" };
    if (token) headers["auth-token"] = token;
    return fetch("/billing-service/bill/v2/_fetchbill?" + qs, {
      method: "POST",
      headers: headers,
      body: body,
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (j) {
        var bills = (j && (j.Bill || j.Bills)) || [];
        if (Array.isArray(bills) && bills.length) return { Bill: bills };
        return emptyPtBill(f.consumerCode, tid);
      })
      .catch(function () {
        return emptyPtBill(f.consumerCode, tid);
      });
  }

  function wrapPtBillService() {
    var ps = window.Digit && Digit.PaymentService;
    if (!ps) return;
    if (typeof ps.fetchBill === "function" && !ps.__ptBillAuthV24) {
      ps.__ptBillAuthV24 = true;
      ps.fetchBill = function (tenantId, filters) {
        return ptAuthFetchBill(tenantId, filters);
      };
    }
    if (typeof ps.searchBill === "function" && !ps.__ptSearchBillV23) {
      ps.__ptSearchBillV23 = true;
      var origSearchBill = ps.searchBill.bind(ps);
      ps.searchBill = function (tenantId, filters) {
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        var f = Object.assign({}, filters || {});
        if (f.consumerCode && String(f.consumerCode).indexOf("PG-PT-") === 0) tid = cityTenant();
        return origSearchBill(tid, f);
      };
    }
  }

  var ptWfKicked = {};
  var ptWfData = {};
  function clearPtWfCache() {
    Object.keys(ptWfKicked).forEach(function (k) {
      delete ptWfKicked[k];
    });
    Object.keys(ptWfData).forEach(function (k) {
      delete ptWfData[k];
    });
  }

  function normalizeRoleCode(r) {
    if (!r) return "";
    if (typeof r === "string") return r;
    return String(r.code || r.name || "").trim();
  }

  function normalizeRoleList(roles) {
    return (roles || []).map(normalizeRoleCode).filter(Boolean);
  }

  function userRoleCodes() {
    try {
      var roles =
        (window.Digit &&
          Digit.UserService &&
          Digit.UserService.getUser &&
          Digit.UserService.getUser() &&
          Digit.UserService.getUser().info &&
          Digit.UserService.getUser().info.roles) ||
        [];
      return normalizeRoleList(roles);
    } catch (e) {
      return [];
    }
  }

  function userHasAnyRole(needed) {
    var codes = userRoleCodes();
    var want = normalizeRoleList(needed);
    if (!want.length) return true;
    // While session roles are still hydrating, keep actions visible.
    if (!codes.length) return true;
    for (var i = 0; i < want.length; i++) {
      if (codes.indexOf(want[i]) !== -1) return true;
    }
    return false;
  }

  function filterPtActionsByRole(actions) {
    return (actions || []).filter(function (a) {
      var roles = normalizeRoleList((a && a.roles) || []);
      if (!roles.length) return true;
      return userHasAnyRole(roles);
    });
  }

  // Hardcoded PT.CREATE / PT.UPDATE / PT.MUTATION actions when WF nextActions is empty.
  function fallbackPtActionsForState(stateName, bsCode) {
    var st = String(stateName || "").toUpperCase();
    var bs = String(bsCode || "PT.CREATE").toUpperCase();
    if (!st || st === "APPROVED" || st === "REJECTED" || st === "INACTIVE") return [];
    if (st === "PAID") {
      return [{ action: "APPROVE", roles: ["PT_APPROVER"] }];
    }
    if (st === "OPEN" || st === "INWORKFLOW" || st === "PENDINGFORASSIGNMENT") {
      return [
        { action: "VERIFY", roles: ["PT_DOC_VERIFIER"] },
        { action: "REJECT", roles: ["PT_DOC_VERIFIER"] },
        { action: "SENDBACKTOCITIZEN", roles: ["PT_DOC_VERIFIER"] },
      ];
    }
    if (st === "DOCVERIFIED") {
      return [{ action: "FORWARD", roles: ["PT_FIELD_INSPECTOR"] }];
    }
    if (st === "FIELDVERIFIED") {
      if (bs === "PT.MUTATION") {
        return [{ action: "PAY", roles: ["CITIZEN", "PT_CEMP"] }];
      }
      return [
        { action: "APPROVE", roles: ["PT_APPROVER"] },
        { action: "REJECT", roles: ["PT_APPROVER"] },
      ];
    }
    if (st === "CORRECTIONPENDING") {
      return [
        { action: "REOPEN", roles: ["CITIZEN", "PT_CEMP"] },
        { action: "REJECT", roles: ["CITIZEN", "PT_CEMP"] },
      ];
    }
    return [];
  }

  function inferPtStateName(pi, property) {
    var name = pi && pi.state && pi.state.state;
    if (name && name !== "PENDINGFORASSIGNMENT" && name !== "pgr-pending" && name !== "INWORKFLOW") return name;
    var propStatus = property && String(property.status || "").toUpperCase();
    if (propStatus === "ACTIVE") return "APPROVED";
    if (propStatus === "INACTIVE") return "INACTIVE";
    if (propStatus === "REJECTED") return "REJECTED";
    var add = property && property.additionalDetails;
    var hinted = add && (add.applicationStatus || add.applicationstatus);
    if (hinted && hinted !== "INWORKFLOW") return hinted;
    var last = pi && pi.action;
    var map = {
      OPEN: "OPEN",
      VERIFY: "DOCVERIFIED",
      FORWARD: "FIELDVERIFIED",
      APPROVE: "APPROVED",
      REJECT: "REJECTED",
      SENDBACKTOCITIZEN: "CORRECTIONPENDING",
      REOPEN: "OPEN",
    };
    if (last && map[last]) return map[last];
    // Empty process + no property hint: do NOT invent OPEN (that faked Take Action on ACTIVE props).
    if (!pi || !pi.state) return propStatus === "INWORKFLOW" ? "OPEN" : "";
    return name || (propStatus === "INWORKFLOW" ? "OPEN" : "");
  }

  function normalize(res) {
    res = res || {};
    if (!Array.isArray(res.ServiceWrappers)) res.ServiceWrappers = [];
    res.ServiceWrappers.forEach(function (sw) {
      if (!sw || !sw.service) return;
      var svc = sw.service;
      svc.address = svc.address || {};
      var loc = svc.address.locality;
      if (!loc) svc.address.locality = { code: "" };
      else if (typeof loc === "string") svc.address.locality = { code: loc };
      else if (loc && !loc.code) svc.address.locality = { code: loc.name || "" };
      if (!svc.serviceCode) svc.serviceCode = "";
      if (!svc.auditDetails) svc.auditDetails = { createdTime: Date.now(), lastModifiedTime: Date.now() };
      if (!svc.applicationStatus) svc.applicationStatus = "PENDINGFORASSIGNMENT";
      if (!sw.workflow) sw.workflow = { action: "APPLY", verificationDocuments: [] };
      if (!Array.isArray(sw.workflow.verificationDocuments)) sw.workflow.verificationDocuments = [];
      if (!sw.workflow.action) sw.workflow.action = "APPLY";
    });
    return res;
  }

  function normalizeProcessInstances(res, businessIds) {
    res = res || {};
    if (!Array.isArray(res.ProcessInstances)) res.ProcessInstances = [];
    if (!res.ProcessInstances.length && businessIds && !isPtPath()) {
      String(businessIds || "")
        .split(",")
        .filter(Boolean)
        .forEach(function (bid) {
          res.ProcessInstances.push({
            businessId: bid,
            businessService: "PGR",
            action: "APPLY",
            assignes: [],
            nextActions: [],
            documents: [],
            tenantId: cityTenant(),
            state: {
              uuid: "pgr-pending",
              state: "PENDINGFORASSIGNMENT",
              applicationStatus: "PENDINGFORASSIGNMENT",
              isStateUpdatable: false,
              actions: [],
            },
            auditDetails: { createdTime: Date.now(), lastModifiedTime: Date.now() },
          });
        });
    }
    res.ProcessInstances.forEach(function (pi) {
      if (!pi) return;
      if (!Array.isArray(pi.nextActions)) pi.nextActions = [];
      if (!Array.isArray(pi.assignes)) pi.assignes = [];
      if (!Array.isArray(pi.documents)) pi.documents = [];
      if (!pi.action) pi.action = isPtPath() ? "OPEN" : "APPLY";
      if (!pi.tenantId) pi.tenantId = cityTenant();
      if (!pi.businessService) pi.businessService = isPtPath() ? "PT.CREATE" : "PGR";
      pi.state = pi.state || {};
      if (!pi.state.uuid) pi.state.uuid = "pgr-pending";
      if (!pi.state.applicationStatus) pi.state.applicationStatus = "PENDINGFORASSIGNMENT";
      if (!pi.state.state) pi.state.state = pi.state.applicationStatus;
      if (!Array.isArray(pi.state.actions)) pi.state.actions = [];
      if (typeof pi.state.isStateUpdatable !== "boolean") pi.state.isStateUpdatable = false;
      pi.auditDetails = pi.auditDetails || { createdTime: Date.now(), lastModifiedTime: Date.now() };
    });
    return res;
  }

  function cleanWfParams(params) {
    var p = Object.assign({}, params || {});
    delete p.start;
    delete p.end;
    if (!p.assignee || p.assignee === "undefined" || p.assignee === "null") delete p.assignee;
    return p;
  }

  function fileIdUrl(id, tenantId) {
    return (
      "https://www.enagariseva.com/filestore/v1/files/id?tenantId=" +
      encodeURIComponent(tenantId) +
      "&fileStoreId=" +
      encodeURIComponent(id)
    );
  }

  function thumbUrl(id, tenantId) {
    var u = fileIdUrl(id, tenantId);
    return u + "," + u + "," + u + "," + u;
  }

  function wrapDefs(arr) {
    arr = Array.isArray(arr) ? arr.slice() : [];
    arr.forEach(function (d) {
      if (d && !d.menuPath) d.menuPath = "OTHERS";
    });
    var origFilter = arr.filter.bind(arr);
    arr.filter = function (fn) {
      var out = origFilter(fn);
      if (!out.length) out = [{ serviceCode: "", menuPath: "OTHERS", name: "Other", active: true }];
      out.forEach(function (d) {
        if (d && !d.menuPath) d.menuPath = "OTHERS";
      });
      return out;
    };
    return arr;
  }

  function fetchRainmakerServiceDefs(tenantId) {
    var tid = hasCity(tenantId) ? String(tenantId) : hasCity(cityTenant()) ? String(cityTenant()) : "pg";
    var token = window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
    var body = {
      RequestInfo: {
        apiId: "Rainmaker",
        authToken: token && token.access_token,
        msgId: "mdms-servicedefs",
      },
      MdmsCriteria: {
        tenantId: tid,
        moduleDetails: [{ moduleName: "RAINMAKER-PGR", masterDetails: [{ name: "ServiceDefs" }] }],
      },
    };
    return fetch("/egov-mdms-service/v1/_search?tenantId=" + encodeURIComponent(tid), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var arr = (d.MdmsRes && d.MdmsRes["RAINMAKER-PGR"] && d.MdmsRes["RAINMAKER-PGR"].ServiceDefs) || [];
        return wrapDefs(
          arr.filter(function (x) {
            return x.active !== false;
          })
        );
      })
      .catch(function () {
        return wrapDefs([]);
      });
  }

  function applyTimeline(item) {
    return {
      performedAction: "APPLY",
      action: "APPLY",
      status: (item && item.status) || "PENDINGFORASSIGNMENT",
      state: (item && item.state) || "PENDINGFORASSIGNMENT",
      timeLineActions: [],
      thumbnailsToShow: (item && item.thumbnailsToShow) || { thumbs: null, fullImage: null, images: [] },
      assigner: null,
      assignes: [],
      caption: null,
      comment: "",
      wfComments: [],
      auditDetails: (item && item.auditDetails) || { created: "", lastModified: "" },
    };
  }

  function collectPhotoIds(wfRes, pgrRes) {
    var ids = [];
    function add(id) {
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    ((wfRes && wfRes.ProcessInstances) || []).forEach(function (pi) {
      (pi.documents || []).forEach(function (d) {
        if (d) add(d.fileStoreId || d.id);
      });
    });
    var sw = ((pgrRes && pgrRes.ServiceWrappers) || [])[0] || {};
    (((sw.workflow || {}).verificationDocuments) || []).forEach(function (d) {
      if (d) add(d.fileStoreId || d.id);
    });
    return ids;
  }

  function thumbsFromIds(ids, tenantId) {
    var urls = (ids || []).map(function (id) {
      return fileIdUrl(id, tenantId);
    });
    return {
      thumbs: urls.length ? urls : null,
      images: urls,
      fullImage: urls,
    };
  }

  function isPtPath(moduleCode) {
    if (moduleCode && String(moduleCode).indexOf("PT") === 0) return true;
    try {
      return !!(window.location && String(window.location.href).indexOf("/pt/") !== -1);
    } catch (e) {
      return false;
    }
  }

  // Digit Application Details often passes moduleCode "PT" (not PT.CREATE).
  // Business-service lookup for "PT" returns nothing → empty nextActions → Take Action missing.
  function normalizePtBusinessService(moduleCode, property) {
    var code = String(moduleCode || "").trim();
    if (code.indexOf("PT.") === 0) return code;
    var cr = property && String(property.creationReason || "").toUpperCase();
    if (cr === "MUTATION") return "PT.MUTATION";
    if (cr === "UPDATE" || cr === "PT.UPDATE") return "PT.UPDATE";
    if (cr === "CREATE") return "PT.CREATE";
    try {
      var path = (window.location && window.location.pathname) || "";
      if (path.indexOf("property-mutate") !== -1 || path.indexOf("/mutation") !== -1) return "PT.MUTATION";
      if (path.indexOf("modify") !== -1 || path.indexOf("update") !== -1) return "PT.UPDATE";
    } catch (ePath) {}
    return "PT.CREATE";
  }

  function isPtAckId(id) {
    id = String(id || "");
    return id.indexOf("-MT-") !== -1 || id.indexOf("-AC-") !== -1 || id.indexOf("-AS-") !== -1;
  }

  function dummyPtOwner() {
    return {
      name: "NA",
      mobileNumber: "",
      gender: "MALE",
      fatherOrHusbandName: "NA",
      relationship: "FATHER",
      ownerType: "NONE",
      status: "INACTIVE",
      documents: [{ documentType: "NA", documentUid: "NA", fileStoreId: "NA" }],
    };
  }

  var ptAckToPropertyId = {};

  function dummyPtProperty() {
    return {
      propertyId: "NA",
      status: "ACTIVE",
      creationReason: "CREATE",
      ownershipCategory: "INDIVIDUAL.SINGLEOWNER",
      owners: [Object.assign({}, dummyPtOwner(), { status: "ACTIVE" })],
      units: [],
      documents: [],
      address: {},
      additionalDetails: {},
      workflow: {},
      auditDetails: { createdTime: 0, lastModifiedTime: Date.now() },
    };
  }

  function rememberPtAck(prop) {
    if (!prop || typeof prop !== "object") return;
    var ack = prop.acknowldgementNumber || prop.acknowledgementNumber || prop.acknowlegmentNumber;
    var pid = prop.propertyId;
    if (ack && pid && !isPtAckId(pid)) ptAckToPropertyId[ack] = pid;
  }

  function mutationAdLooksFilled(ad) {
    if (!ad || typeof ad !== "object") return false;
    return (
      ad.marketValue != null ||
      ad.documentNumber != null ||
      ad.documentValue != null ||
      ad.documentDate != null ||
      !!ad.reasonForTransfer ||
      !!ad.isMutationInCourt ||
      !!ad.isPropertyUnderGovtPossession
    );
  }

  function cacheMutationAdditionalDetails(prop) {
    if (!prop || typeof prop !== "object") return;
    if (String(prop.creationReason || "") !== "MUTATION") return;
    var ad = prop.additionalDetails;
    if (!mutationAdLooksFilled(ad)) return;
    var copy = Object.assign({}, ad);
    var keys = [prop.propertyId, prop.acknowldgementNumber, prop.acknowledgementNumber, prop.acknowlegmentNumber];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i]) ptMutationAdCache[String(keys[i])] = copy;
    }
  }

  function restoreMutationAdditionalDetails(prop) {
    if (!prop || typeof prop !== "object") return prop;
    if (mutationAdLooksFilled(prop.additionalDetails)) {
      cacheMutationAdditionalDetails(prop);
      return prop;
    }
    var keys = [prop.propertyId, prop.acknowldgementNumber, prop.acknowledgementNumber, prop.acknowlegmentNumber];
    var cached = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && ptMutationAdCache[String(keys[i])]) {
        cached = ptMutationAdCache[String(keys[i])];
        break;
      }
    }
    if (!cached) {
      try {
        var path = (window.location && window.location.pathname) || "";
        var m = path.match(/application-details\/([^/?#]+)/i);
        if (m && ptMutationAdCache[m[1]]) cached = ptMutationAdCache[m[1]];
      } catch (ePath) {}
    }
    if (cached) {
      prop.additionalDetails = Object.assign({}, cached, prop.additionalDetails || {});
    }
    return prop;
  }

  function propertyIdFromAppDetailsPath() {
    try {
      var path = (window.location && window.location.pathname) || "";
      var m = path.match(/application-details\/(PG-PT-[^/?#]+)/i);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  }

  function rewritePtSearchArgs(args) {
    var a = Object.assign({}, args || {});
    var filters = Object.assign({}, a.filters || {});
    var pid = filters.propertyIds;
    var ack = filters.acknowledgementIds;
    // Mutation details audit crashes if ack is used: API 400 + then ACTIVE[1] is undefined.
    if (filters.audit && (isPtAckId(pid) || isPtAckId(ack))) {
      var realId = ptAckToPropertyId[pid] || ptAckToPropertyId[ack];
      if (!realId && pid && !isPtAckId(pid)) realId = pid;
      if (realId) {
        filters.propertyIds = realId;
        delete filters.acknowledgementIds;
        a.filters = filters;
        return a;
      }
    }
    if (isPtAckId(pid) && !filters.acknowledgementIds) {
      var mapped = ptAckToPropertyId[pid];
      if (filters.audit && mapped) {
        filters.propertyIds = mapped;
      } else {
        filters.acknowledgementIds = pid;
        delete filters.propertyIds;
      }
      a.filters = filters;
    }
    return a;
  }

  /** Digit mutation page: ACTIVE.sort(...)[status?1:0].ownershipCategory — needs ≥2 ACTIVE rows. */
  function ensureTwoActiveAuditProps(props) {
    props = Array.isArray(props) ? props.filter(Boolean) : [];
    var active = props.filter(function (p) {
      return p && String(p.status || "").toUpperCase() === "ACTIVE";
    });
    if (active.length >= 2) return props;
    var src = active[0] || props[0] || dummyPtProperty();
    src = normalizeProperty(Object.assign({}, src));
    src.status = "ACTIVE";
    src.ownershipCategory = src.ownershipCategory || "INDIVIDUAL.SINGLEOWNER";
    src.auditDetails = Object.assign({ lastModifiedTime: Date.now() }, src.auditDetails || {});
    if (!src.auditDetails.lastModifiedTime) src.auditDetails.lastModifiedTime = Date.now();
    var older = normalizeProperty(Object.assign({}, src, {
      status: "ACTIVE",
      ownershipCategory: "INDIVIDUAL.SINGLEOWNER",
      creationReason: "CREATE",
      institution: null,
      auditDetails: Object.assign({}, src.auditDetails, {
        lastModifiedTime: (src.auditDetails.lastModifiedTime || Date.now()) - 1000,
      }),
      owners: (src.owners || [dummyPtOwner()]).map(function (o) {
        return Object.assign({}, o || dummyPtOwner(), { status: "ACTIVE", gender: (o && o.gender) || "MALE" });
      }),
    }));
    // Newest first in list; Digit re-sorts by lastModifiedTime.
    return [src, older].concat(
      props.filter(function (p) {
        return p !== active[0];
      })
    );
  }

  function hardenPtSearchResult(result, args) {
    if (!result) return { data: { Properties: [] }, isLoading: false, isError: false, error: null };
    try {
      var filters = (args && args.filters) || {};
      var data = result.data;
      var props = [];
      if (Array.isArray(data)) {
        props = data.slice();
      } else if (data && Array.isArray(data.Properties)) {
        props = data.Properties.slice();
      } else if (data && data[0] && typeof data[0] === "object") {
        props = [data[0]];
      }
      props = props.filter(Boolean).map(function (p) {
        p = normalizeProperty(Object.assign({}, p));
        if (typeof p.ownershipCategory !== "string") {
          p.ownershipCategory = (p.ownershipCategory && p.ownershipCategory.code) || "INDIVIDUAL.SINGLEOWNER";
        }
        p.auditDetails = Object.assign({ lastModifiedTime: 0 }, p.auditDetails || {});
        if (p.auditDetails.lastModifiedTime == null) p.auditDetails.lastModifiedTime = 0;
        rememberPtAck(p);
        return p;
      });
      if (filters.audit) {
        if (!props.length) props = [dummyPtProperty()];
        props = ensureTwoActiveAuditProps(props);
      }
      props.forEach(function (p) {
        normalizeProperty(p);
        rememberPtAck(p);
      });
      var shaped = Object.assign({}, Array.isArray(data) ? {} : data || {}, { Properties: props });
      if (props[0]) shaped[0] = props[0];
      result.data = shaped;
      if (result.isError) {
        result.isError = false;
        result.error = null;
      }
    } catch (e) {
      result.data = { Properties: [dummyPtProperty()], 0: dummyPtProperty() };
      result.isError = false;
      result.error = null;
    }
    return result;
  }

  function defaultRolesForAction(action) {
    if (action === "RESOLVE" || action === "REASSIGN") return ["PGR_LME"];
    if (action === "ASSIGN") return ["GRO", "DGRO"];
    if (action === "VERIFY" || action === "SENDBACKTOCITIZEN") return ["PT_DOC_VERIFIER"];
    if (action === "FORWARD") return ["PT_FIELD_INSPECTOR"];
    if (action === "APPROVE") return ["PT_APPROVER"];
    if (action === "REJECT") return ["PT_DOC_VERIFIER", "PT_APPROVER", "PT_CEMP"];
    if (action === "REOPEN") return ["CITIZEN", "PT_CEMP"];
    if (action === "PAY") return ["CITIZEN", "PT_CEMP"];
    if (action === "INACTIVE_PROPERTY" || action === "PT_INACTIVE_PROPERTY") return ["PT_APPROVER", "PT_CEMP"];
    return ["GRO", "DGRO"];
  }

  function defaultAssigneeRolesForAction(action) {
    if (action === "ASSIGN") return ["PGR_LME"];
    // VERIFY: do not force Field Inspector picker — empty dropdown was blocking Doc Verifier.
    if (action === "VERIFY" || action === "SENDBACKTOCITIZEN" || action === "REJECT") return [];
    // FORWARD: leave empty so enrichPtActions derives from next state
    // (CREATE→PT_APPROVER, MUTATION→PT_CEMP/none — never force Approver on mutation).
    if (action === "FORWARD") return [];
    return [];
  }

  function normalizeNextActions(list) {
    if (!Array.isArray(list)) list = [];
    var out = [];
    list.forEach(function (item) {
      if (!item) return;
      var action = typeof item === "string" ? item : item.action;
      if (!action) return;
      var base = typeof item === "object" ? Object.assign({}, item) : {};
      base.action = action;
      // Digit WF_TAKE_ACTION filters with roles.includes(userRoleCode) — must be string codes.
      var roleSrc = Array.isArray(base.roles) && base.roles.length ? base.roles : defaultRolesForAction(action);
      base.roles = normalizeRoleList(roleSrc);
      var assignSrc =
        Array.isArray(base.assigneeRoles) && base.assigneeRoles.length
          ? base.assigneeRoles
          : defaultAssigneeRolesForAction(action);
      base.assigneeRoles = normalizeRoleList(assignSrc);
      if (typeof base.isTerminateState !== "boolean") {
        base.isTerminateState = action === "REJECT" || action === "APPROVE";
      }
      if (action === "REJECT" || action === "APPROVE" || action === "INACTIVE_PROPERTY" || action === "PT_INACTIVE_PROPERTY") {
        base.isTerminateState = true;
        if (action === "INACTIVE_PROPERTY" || action === "PT_INACTIVE_PROPERTY") base.assigneeRoles = [];
      }
      out.push(base);
    });
    return out;
  }

  function authHeaders() {
    var u = window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
    var token = u && (u.access_token || u.token);
    var info = (u && u.info) || u || {};
    return {
      token: token,
      info: info,
    };
  }

  function fetchProcessByAssignee(tid, uuid) {
    var a = authHeaders();
    return fetch(
      "/egov-workflow-v2/egov-wf/process/_search?tenantId=" +
        encodeURIComponent(tid) +
        "&assignee=" +
        encodeURIComponent(uuid),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          RequestInfo: {
            apiId: "Rainmaker",
            authToken: a.token,
            userInfo: a.info,
            msgId: "pgr-wf-assignee",
          },
        }),
      }
    ).then(function (r) {
      return r.json();
    });
  }

  function fetchProcessInstances(tid, id) {
    var a = authHeaders();
    return fetch(
      "/egov-workflow-v2/egov-wf/process/_search?tenantId=" +
        encodeURIComponent(tid) +
        "&businessIds=" +
        encodeURIComponent(id) +
        "&history=true",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          RequestInfo: {
            apiId: "Rainmaker",
            authToken: a.token,
            userInfo: a.info,
            msgId: "pgr-wf",
          },
        }),
      }
    ).then(function (r) {
      return r.json();
    });
  }

  function fetchPropertyHint(tid, id) {
    var a = authHeaders();
    function search(params) {
      return fetch("/property-services/property/_search?" + params, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          RequestInfo: {
            apiId: "Rainmaker",
            authToken: a.token,
            userInfo: a.info,
            msgId: "pt-wf-prop",
          },
        }),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          return (d && d.Properties && d.Properties[0]) || null;
        });
    }
    var tidQ = "tenantId=" + encodeURIComponent(tid);
    var first =
      String(id).indexOf("-AC-") !== -1
        ? search(tidQ + "&acknowledgementIds=" + encodeURIComponent(id))
        : search(tidQ + "&propertyIds=" + encodeURIComponent(id));
    return first
      .then(function (p) {
        if (p) return p;
        return search(tidQ + "&acknowledgementIds=" + encodeURIComponent(id)).then(function (p2) {
          return p2 || search(tidQ + "&propertyIds=" + encodeURIComponent(id));
        });
      })
      .catch(function () {
        return null;
      });
  }

  function fetchBusinessService(tid, name) {
    var a = authHeaders();
    var stateTid = String(tid || "pg").split(".")[0] || "pg";
    var bsName = normalizePtBusinessService(name);
    return fetch(
      "/egov-workflow-v2/egov-wf/businessservice/_search?tenantId=" +
        encodeURIComponent(stateTid) +
        "&businessServices=" +
        encodeURIComponent(bsName),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          RequestInfo: {
            apiId: "Rainmaker",
            authToken: a.token,
            userInfo: a.info,
            msgId: "pt-wf-bs",
          },
        }),
      }
    ).then(function (r) {
      return r.json();
    });
  }

  function enrichPtActions(nextActions, states) {
    states = states || [];
    var byUuid = {};
    var byName = {};
    states.forEach(function (st) {
      if (!st) return;
      if (st.uuid) byUuid[st.uuid] = st;
      if (st.state) byName[st.state] = st;
    });
    return (nextActions || [])
      .map(function (item) {
        var action = typeof item === "string" ? { action: item } : Object.assign({}, item || {});
        if (!action.action) return null;
        var next =
          byUuid[action.nextState] ||
          byName[action.nextState] ||
          (action.state && typeof action.state === "object" ? action.state : byName[action.state]);
        var nextActs = (next && next.actions) || [];
        // Prefer next-state roles (mutation FIELDVERIFIED=PAY→PT_CEMP) over any preset.
        var derived = [];
        nextActs.forEach(function (ac) {
          (ac.roles || []).forEach(function (r) {
            if (r && r !== "CITIZEN" && derived.indexOf(r) === -1) derived.push(r);
          });
        });
        var assigneeRoles = derived.length
          ? derived
          : Array.isArray(action.assigneeRoles) && action.assigneeRoles.length
            ? action.assigneeRoles.slice()
            : defaultAssigneeRolesForAction(action.action);
        action.assigneeRoles = assigneeRoles;
        if (typeof action.isTerminateState !== "boolean") {
          action.isTerminateState = !!(next && next.isTerminateState);
        }
        if (action.action === "REJECT" || action.action === "APPROVE") action.isTerminateState = true;
        if (
          action.action === "VERIFY" ||
          action.action === "SENDBACKTOCITIZEN" ||
          action.action === "REJECT" ||
          action.action === "INACTIVE_PROPERTY" ||
          action.action === "PT_INACTIVE_PROPERTY"
        ) {
          action.assigneeRoles = [];
        }
        if (action.action === "INACTIVE_PROPERTY" || action.action === "PT_INACTIVE_PROPERTY") {
          action.isTerminateState = true;
        }
        if (!Array.isArray(action.roles) || !action.roles.length) action.roles = defaultRolesForAction(action.action);
        return action;
      })
      .filter(Boolean);
  }

  function actionsFromCurrentState(pi, states, property) {
    var curName = inferPtStateName(pi, property);
    if (!curName) return [];
    if (curName === "APPROVED" || curName === "REJECTED" || curName === "INACTIVE") return [];
    var propStatus = property && String(property.status || "").toUpperCase();
    if (propStatus === "ACTIVE" || propStatus === "INACTIVE" || propStatus === "REJECTED") return [];
    var curUuid = pi && pi.state && pi.state.uuid;
    if (curUuid === "pgr-pending") curUuid = "";
    var cur = null;
    (states || []).forEach(function (st) {
      if (!st) return;
      if (curUuid && st.uuid === curUuid) cur = st;
      else if (!cur && st.state === curName) cur = st;
    });
    var src =
      (cur && cur.actions) ||
      (pi && pi.state && Array.isArray(pi.state.actions) && pi.state.actions.length && pi.state.actions) ||
      (pi && Array.isArray(pi.nextActions) && pi.nextActions.length && pi.nextActions) ||
      [];
    var bsCode = normalizePtBusinessService(
      (pi && pi.businessService) || (property && property.creationReason) || "PT.CREATE",
      property
    );
    if (!src || !src.length) src = fallbackPtActionsForState(curName, bsCode);
    return filterPtActionsByRole(enrichPtActions(src, states));
  }

  function finalizePtWorkflow(data, moduleCode, states) {
    data = data && typeof data === "object" ? data : {};
    if (!Array.isArray(data.timeline)) data.timeline = [];
    data.timeline = data.timeline.filter(Boolean).map(function (item) {
      item.performedAction = item.performedAction || item.action || "OPEN";
      if (!Array.isArray(item.timeLineActions)) item.timeLineActions = [];
      if (!item.thumbnailsToShow || typeof item.thumbnailsToShow !== "object") {
        item.thumbnailsToShow = { thumbs: null, fullImage: null, images: [] };
      }
      if (!Array.isArray(item.wfComments)) item.wfComments = [];
      // Digit UI references an undefined Reason component when timeline.comment is set.
      if (item.comment != null && String(item.comment) !== "") {
        if (!Array.isArray(item.wfComment)) item.wfComment = [];
        var cmt = String(item.comment);
        if (item.wfComment.indexOf(cmt) === -1) item.wfComment.push(cmt);
      }
      item.comment = "";
      if (!Array.isArray(item.wfComment)) item.wfComment = [];
      return item;
    });
    var property = data.__ptProperty || null;
    var bsCode = normalizePtBusinessService(
      data.applicationBusinessService || data.businessService || moduleCode,
      property
    );
    var prior =
      filterPtActionsByRole(
        enrichPtActions(
          (data.actionState && data.actionState.nextActions) || data.nextActions || [],
          states
        )
      ) || [];
    var merged = actionsFromCurrentState((data.processInstances || [])[0] || {}, states, property);
    if (!merged.length) merged = prior;
    if (!merged.length) {
      var fallback = (data.actionState && data.actionState.nextActions) || data.nextActions || [];
      merged = filterPtActionsByRole(enrichPtActions(fallback, states));
    }
    // Never wipe already-good actions when BS states failed to load.
    if (!merged.length && prior.length) merged = prior;
    data.nextActions = merged;
    data.actionState = data.actionState || {};
    data.actionState.nextActions = merged;
    data.initialActionState = data.initialActionState || data.actionState;
    data.initialActionState.nextActions = merged;
    data.businessService = bsCode;
    data.applicationBusinessService = bsCode;
    data.processInstances = data.processInstances || [];
    return data;
  }

  function ptWorkflowDetails(tid, id, moduleCode) {
    tid = hasCity(tid) ? tid : cityTenant();
    return fetchPropertyHint(tid, id)
      .catch(function () {
        return null;
      })
      .then(function (property) {
        var bsCode = normalizePtBusinessService(moduleCode, property);
        // Workflow businessId is acknowledgement number, not propertyId.
        var wfId =
          (property && (property.acknowldgementNumber || property.acknowledgementNumber)) ||
          (isPtAckId(id) ? id : "");
        var propStatus = property && String(property.status || "").toUpperCase();
        var terminated =
          propStatus === "ACTIVE" ||
          propStatus === "INACTIVE" ||
          propStatus === "REJECTED" ||
          propStatus === "CANCELLED";
        var piCall = wfId
          ? fetchProcessInstances(tid, wfId).catch(function () {
              return { ProcessInstances: [] };
            })
          : Promise.resolve({ ProcessInstances: [] });
        return Promise.all([
          piCall,
          fetchBusinessService(tid, bsCode).catch(function () {
            return { BusinessServices: [] };
          }),
        ]).then(function (res) {
          var pis = (res[0] && res[0].ProcessInstances) || [];
          var bs = ((res[1] && res[1].BusinessServices) || [])[0] || {};
          if ((!bs.states || !bs.states.length) && bsCode !== "PT.CREATE") {
            return fetchBusinessService(tid, "PT.CREATE")
              .catch(function () {
                return { BusinessServices: [] };
              })
              .then(function (retry) {
                return {
                  pis: pis,
                  bs: ((retry && retry.BusinessServices) || [])[0] || {},
                  property: property,
                  bsCode: "PT.CREATE",
                  terminated: terminated,
                };
              });
          }
          return { pis: pis, bs: bs, property: property, bsCode: bsCode, terminated: terminated };
        });
      })
      .then(function (pack) {
        var pis = pack.pis || [];
        var bs = pack.bs || {};
        var property = pack.property || null;
        var bsCode = pack.bsCode || "PT.CREATE";
        var states = bs.states || [];
        var currentPi = pis[0] || null;
        pis.forEach(function (pi) {
          if (!currentPi) currentPi = pi;
          var at = (pi.auditDetails && pi.auditDetails.lastModifiedTime) || 0;
          var bt = (currentPi.auditDetails && currentPi.auditDetails.lastModifiedTime) || 0;
          if (at >= bt) currentPi = pi;
        });
        if (!currentPi) {
          return finalizePtWorkflow(
            {
              timeline: [],
              nextActions: [],
              actionState: { nextActions: [] },
              processInstances: [],
              businessService: bsCode,
              applicationBusinessService: bsCode,
              __ptProperty: property,
            },
            bsCode,
            states
          );
        }
        if (currentPi.businessService) bsCode = normalizePtBusinessService(currentPi.businessService, property);
        var stateName = inferPtStateName(currentPi, property);
        if (!stateName && pack.terminated) stateName = "APPROVED";
        currentPi = Object.assign({}, currentPi, {
          action: currentPi.action || "OPEN",
          businessService: currentPi.businessService || bsCode,
          state: Object.assign({}, currentPi.state || {}, {
            state: stateName || (currentPi.state && currentPi.state.state) || "",
            applicationStatus:
              (currentPi.state && currentPi.state.applicationStatus) ||
              (property && property.status) ||
              "INWORKFLOW",
            actions:
              (currentPi.state && currentPi.state.actions && currentPi.state.actions.length && currentPi.state.actions) ||
              (function () {
                var cur = null;
                states.forEach(function (st) {
                  if (st && st.state === stateName) cur = st;
                });
                return (cur && cur.actions) || [];
              })(),
          }),
        });
        // Terminated/ACTIVE applications: never invent workflow actions.
        var nextActions = pack.terminated ? [] : actionsFromCurrentState(currentPi, states, property);
        var timeline = pis.map(function (pi) {
          var status = (pi.state && (pi.state.applicationStatus || pi.state.state)) || "OPEN";
          return {
            performedAction: pi.action || "OPEN",
            action: pi.action || "OPEN",
            status: status,
            state: (pi.state && pi.state.state) || status,
            timeLineActions: [],
            thumbnailsToShow: { thumbs: null, images: [], fullImage: null },
            assigner: pi.assigner || null,
            assignes: pi.assignes || [],
            caption: (pi.assignes || []).map(function (a) {
              return { name: a.name, mobileNumber: a.mobileNumber };
            }),
            comment: "",
            wfComment: pi.comment ? [pi.comment] : [],
            wfComments: pi.comment ? [pi.comment] : [],
            wfDocuments: pi.documents || [],
            auditDetails: {
              created: pi.auditDetails && pi.auditDetails.createdTime,
              lastModified: pi.auditDetails && pi.auditDetails.lastModifiedTime,
            },
          };
        });
        return finalizePtWorkflow(
          {
            timeline: timeline,
            nextActions: nextActions,
            actionState: Object.assign({}, currentPi.state || {}, {
              nextActions: nextActions,
              isStateUpdatable: !!(currentPi.state && currentPi.state.isStateUpdatable),
            }),
            processInstances: pis,
            businessService: bsCode,
            applicationBusinessService: bsCode,
            __ptProperty: property,
          },
          bsCode,
          states
        );
      });
  }

  function pgrWorkflowDetails(tid, id) {
    tid = hasCity(tid) ? tid : cityTenant();
    var wfCall = fetchProcessInstances(tid, id).catch(function () {
      return { ProcessInstances: [] };
    });
    var pgrCall = Digit.PGRService.search(tid, { serviceRequestId: id }).catch(function () {
      return { ServiceWrappers: [] };
    });
    return Promise.all([wfCall, pgrCall])
      .then(function (res) {
        var wfRes = res[0] || {};
        var pgrRes = res[1] || {};
        var ids = collectPhotoIds(wfRes, pgrRes);
        var thumbnailsToShow = thumbsFromIds(ids, tid);
        var pis = wfRes.ProcessInstances || [];
        var currentPi = null;
        pis.forEach(function (pi) {
          if (!currentPi) currentPi = pi;
          var a = (pi && pi.nextActions) || [];
          var b = (currentPi && currentPi.nextActions) || [];
          if (a.length > b.length) currentPi = pi;
          var at = (pi.auditDetails && pi.auditDetails.lastModifiedTime) || 0;
          var bt = (currentPi.auditDetails && currentPi.auditDetails.lastModifiedTime) || 0;
          if (at > bt && a.length >= b.length) currentPi = pi;
        });
        var timeline = pis.map(function (pi) {
          var status = (pi.state && (pi.state.applicationStatus || pi.state.state)) || "PENDINGFORASSIGNMENT";
          var action = pi.action || "APPLY";
          return {
            performedAction: action,
            action: action,
            status: status,
            state: (pi.state && pi.state.state) || status,
            timeLineActions: [],
            thumbnailsToShow: action === "APPLY" ? thumbnailsToShow : { thumbs: null, images: [], fullImage: null },
            assigner: pi.assigner || null,
            assignes: pi.assignes || [],
            caption: (pi.assignes || []).map(function (a) {
              return { name: a.name, mobileNumber: a.mobileNumber };
            }),
            comment: "",
            wfComment: pi.comment ? [pi.comment] : [],
            wfComments: pi.comment ? [pi.comment] : [],
            auditDetails: {
              created: pi.auditDetails && pi.auditDetails.createdTime,
              lastModified: pi.auditDetails && pi.auditDetails.lastModifiedTime,
            },
          };
        });
        var data = {
          timeline: timeline,
          nextActions: normalizeNextActions((currentPi && currentPi.nextActions) || []),
          actionState: Object.assign({}, currentPi || {}, {
            nextActions: normalizeNextActions((currentPi && currentPi.nextActions) || []),
          }),
          processInstances: pis,
          businessService: "PGR",
        };
        ensureSafeWorkflowDetails(data, id);
        data.timeline.forEach(function (item) {
          if (item.performedAction === "APPLY") item.thumbnailsToShow = thumbnailsToShow;
        });
        return data;
      })
      .catch(function () {
        return pgrCall
          .then(function (pgrRes) {
            var ids = collectPhotoIds({ ProcessInstances: [] }, pgrRes);
            var thumbnailsToShow = thumbsFromIds(ids, tid);
            var data = ensureSafeWorkflowDetails({ timeline: [applyTimeline({ thumbnailsToShow: thumbnailsToShow })] }, id);
            data.timeline.forEach(function (item) {
              if (item.performedAction === "APPLY") item.thumbnailsToShow = thumbnailsToShow;
            });
            return data;
          })
          .catch(function () {
            return ensureSafeWorkflowDetails({}, id);
          });
      });
  }

  function ensureSafeWorkflowDetails(data, id) {
    data = data && typeof data === "object" ? data : {};
    if (!Array.isArray(data.timeline)) data.timeline = [];
    data.timeline = data.timeline.filter(Boolean).map(function (item) {
      item.performedAction = item.performedAction || item.action || "APPLY";
      if (!Array.isArray(item.timeLineActions)) item.timeLineActions = [];
      if (!item.thumbnailsToShow || typeof item.thumbnailsToShow !== "object") {
        item.thumbnailsToShow = { thumbs: null, fullImage: null, images: [] };
      }
      if (!Array.isArray(item.wfComments)) item.wfComments = [];
      // Always strip timeline.comment — Digit Reason component is undefined → white crash page.
      if (item.comment != null && String(item.comment) !== "") {
        if (!Array.isArray(item.wfComment)) item.wfComment = [];
        var c = String(item.comment);
        if (item.wfComment.indexOf(c) === -1) item.wfComment.push(c);
      }
      item.comment = "";
      if (!Array.isArray(item.wfComment)) item.wfComment = [];
      return item;
    });
    var hasApply = data.timeline.some(function (x) {
      return x && x.performedAction === "APPLY";
    });
    if (!hasApply && !isPtPath(data.businessService || data.applicationBusinessService)) {
      data.timeline = [applyTimeline(data.timeline[0])].concat(data.timeline);
    }
    data.nextActions = normalizeNextActions(
      (Array.isArray(data.nextActions) && data.nextActions.length && data.nextActions) ||
        (function () {
          var best = [];
          (data.processInstances || []).forEach(function (pi) {
            var na = (pi && pi.nextActions) || [];
            if (na.length > best.length) best = na;
            var sa = pi && pi.state && pi.state.actions;
            if ((!best.length || best.length < (sa || []).length) && Array.isArray(sa) && sa.length) best = sa;
          });
          return best;
        })()
    );
    data.actionState = data.actionState || {};
    data.actionState.nextActions = normalizeNextActions(data.actionState.nextActions || data.nextActions);
    data.initialActionState = data.initialActionState || data.actionState || {};
    data.initialActionState.nextActions = normalizeNextActions(
      data.initialActionState.nextActions || data.nextActions
    );
    if (!data.businessService) data.businessService = isPtPath() ? "PT.CREATE" : "PGR";
    data.processInstances = data.processInstances || data.ProcessInstances || [];
    return data;
  }

  function patchServices() {
    if (!window.Digit || !Digit.PGRService || !Digit.PGRService.search) return false;
    if (!Digit.WorkflowService || !Digit.WorkflowService.getDetailsById) return false;

    if (!Digit.PGRService.__pgrInboxPatchedV10) {
      Digit.PGRService.__pgrInboxPatchedV10 = true;

      var origSearch = Digit.PGRService.search.bind(Digit.PGRService);
      Digit.PGRService.search = function (tenantId, filters) {
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        var f = Object.assign({}, filters || {});
        delete f.start;
        delete f.end;
        if (!hasCity(f.tenantId)) delete f.tenantId;
        return Promise.resolve(origSearch(tid, f))
          .then(normalize)
          .catch(function () {
            return Promise.resolve(origSearch(cityTenant(), f))
              .then(normalize)
              .catch(function () {
                return { ServiceWrappers: [] };
              });
          });
      };

      if (Digit.PGRService.count) {
        var origCount = Digit.PGRService.count.bind(Digit.PGRService);
        Digit.PGRService.count = function (tenantId, filters) {
          var tid = hasCity(tenantId) ? tenantId : cityTenant();
          var f = Object.assign({}, filters || {});
          delete f.start;
          delete f.end;
          return Promise.resolve(origCount(tid, f)).catch(function () {
            return Promise.resolve(origCount(cityTenant(), f)).catch(function () {
              return { count: 0 };
            });
          });
        };
      }
    }

    if (Digit.WorkflowService && Digit.WorkflowService.init && !Digit.WorkflowService.__pgrInitV10) {
      Digit.WorkflowService.__pgrInitV10 = true;
      var origInit = Digit.WorkflowService.init.bind(Digit.WorkflowService);
      Digit.WorkflowService.init = function (tenantId, businessServices) {
        var stateTid = String(tenantId || cityTenant()).split(".")[0] || "pg";
        return Promise.resolve(origInit(stateTid, businessServices || "PGR")).catch(function () {
          return origInit("pg", businessServices || "PGR");
        });
      };
    }

    if (Digit.WorkflowService && Digit.WorkflowService.getByBusinessId && !Digit.WorkflowService.__pgrGetByIdV13) {
      Digit.WorkflowService.__pgrGetByIdV13 = true;
      var origWf = Digit.WorkflowService.getByBusinessId.bind(Digit.WorkflowService);

      function matchesAssignee(pi, uid) {
        if (!uid) return true;
        uid = String(uid);
        if (pi.assignee && String(pi.assignee) === uid) return true;
        var list = pi.assignes || [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!a) continue;
          if (typeof a === "string" && a === uid) return true;
          if (String(a.uuid || a.id || "") === uid) return true;
        }
        return false;
      }

      Digit.WorkflowService.getByBusinessId = function (stateCode, businessIds, params, history) {
        var tid = hasCity(stateCode) ? stateCode : cityTenant();
        var p = cleanWfParams(params);
        var assignee = p.assignee;
        var hasAssigneeFilter = !!assignee;
        if (history === undefined) history = false;
        if (!businessIds) {
          if (hasAssigneeFilter) return fetchProcessByAssignee(tid, assignee);
          return Promise.resolve({ ProcessInstances: [] });
        }
        return Promise.resolve(origWf(tid, businessIds, p, history))
          .then(function (res) {
            res = res || {};
            if (!Array.isArray(res.ProcessInstances)) res.ProcessInstances = [];
            if (hasAssigneeFilter && !res.ProcessInstances.length) {
              return fetchProcessByAssignee(tid, assignee).then(function (byA) {
                byA = byA || {};
                if (!Array.isArray(byA.ProcessInstances)) byA.ProcessInstances = [];
                var want = String(businessIds).split(",");
                byA.ProcessInstances = byA.ProcessInstances.filter(function (pi) {
                  return pi && want.indexOf(pi.businessId) !== -1;
                });
                return byA;
              });
            }
            res = normalizeProcessInstances(res, hasAssigneeFilter ? null : businessIds);
            if (hasAssigneeFilter) {
              res.ProcessInstances = res.ProcessInstances.filter(function (pi) {
                return matchesAssignee(pi, assignee);
              });
            }
            return res;
          })
          .catch(function () {
            if (hasAssigneeFilter) return fetchProcessByAssignee(tid, assignee);
            return normalizeProcessInstances({ ProcessInstances: [] }, businessIds);
          });
      };
    }

    if (Digit.WorkflowService && Digit.WorkflowService.getDetailsById && !Digit.WorkflowService.__pgrDetailsV18) {
      Digit.WorkflowService.__pgrDetailsV18 = true;
      var origDetails = Digit.WorkflowService.getDetailsById.bind(Digit.WorkflowService);
      Digit.WorkflowService.getDetailsById = function (args) {
        args = args || {};
        var tid = hasCity(args.tenantId) ? args.tenantId : cityTenant();
        var id = args.id;
        var isPgr =
          args.moduleCode === "PGR" ||
          (typeof window !== "undefined" && window.location && String(window.location.href).indexOf("/pgr/") !== -1);
        var isPt = isPtPath(args.moduleCode);
        if (isPgr) return pgrWorkflowDetails(tid, id);
        if (isPt) {
          return ptWorkflowDetails(tid, id, args.moduleCode).catch(function () {
            return Promise.resolve(origDetails(Object.assign({}, args, { tenantId: tid })))
              .then(function (data) {
                return fetchBusinessService(tid, normalizePtBusinessService(args.moduleCode))
                  .then(function (bsRes) {
                    var states = (((bsRes || {}).BusinessServices || [])[0] || {}).states || [];
                    return finalizePtWorkflow(data, normalizePtBusinessService(args.moduleCode), states);
                  })
                  .catch(function () {
                    return finalizePtWorkflow(data, normalizePtBusinessService(args.moduleCode), []);
                  });
              })
              .catch(function () {
                return finalizePtWorkflow({}, normalizePtBusinessService(args.moduleCode), []);
              });
          });
        }
        return Promise.resolve(origDetails(Object.assign({}, args, { tenantId: tid })))
          .then(function (data) {
            return ensureSafeWorkflowDetails(data, id);
          })
          .catch(function () {
            return ensureSafeWorkflowDetails({}, id);
          });
      };
    }

    if (Digit.MDMSService && Digit.MDMSService.getServiceDefs && !Digit.MDMSService.__pgrDefsV10) {
      Digit.MDMSService.__pgrDefsV10 = true;
      Digit.MDMSService.getServiceDefs = function (tenantId) {
        return fetchRainmakerServiceDefs(tenantId);
      };
    }

    if (Digit.UploadServices && Digit.UploadServices.Filestorage && !Digit.UploadServices.__pgrUploadV10) {
      Digit.UploadServices.__pgrUploadV10 = true;
      var origUpload = Digit.UploadServices.Filestorage.bind(Digit.UploadServices);
      Digit.UploadServices.Filestorage = function (module, filedata, tenantId) {
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        return Promise.resolve(origUpload(module, filedata, tid));
      };
    }

    if (Digit.UploadServices && Digit.UploadServices.Filefetch && !Digit.UploadServices.__pgrFetchV10) {
      Digit.UploadServices.__pgrFetchV10 = true;
      Digit.UploadServices.Filefetch = function (filesArray, tenantId) {
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        var data = { fileStoreIds: [] };
        (filesArray || []).forEach(function (id) {
          if (id && typeof id === "object") id = id.fileStoreId || id.id;
          if (!id) return;
          var u = thumbUrl(id, tid);
          data[id] = u;
          data.fileStoreIds.push({ id: id, url: u });
        });
        return Promise.resolve({ data: data });
      };
    }

    if (Digit.Utils && !Digit.Utils.__pgrFileUrlV10) {
      Digit.Utils.__pgrFileUrlV10 = true;
      var origGetFileUrl = Digit.Utils.getFileUrl && Digit.Utils.getFileUrl.bind(Digit.Utils);
      Digit.Utils.getFileUrl = function (url) {
        try {
          if (!url) return "";
          if (origGetFileUrl) {
            var out = origGetFileUrl(url);
            if (out) return out;
          }
          return String(url).split(",")[0];
        } catch (e) {
          return String(url || "").split(",")[0] || "";
        }
      };
    }

    if (Digit.PTService && Digit.PTService.search && !Digit.PTService.__ptSearchV72) {
      Digit.PTService.__ptSearchV72 = true;
      var origPtSearch = Digit.PTService.search.bind(Digit.PTService);
      Digit.PTService.search = function (args) {
        var a = rewritePtSearchArgs(args || {});
        var filters = (a && a.filters) || {};
        return Promise.resolve(origPtSearch.call(Digit.PTService, a))
          .then(function (res) {
            res = res || {};
            if (!Array.isArray(res.Properties)) res.Properties = [];
            res.Properties.forEach(function (p) {
              normalizeProperty(p);
              rememberPtAck(p);
            });
            if (filters.audit) res.Properties = ensureTwoActiveAuditProps(res.Properties);
            if (res.Properties.length) return res;
            var origFilters = (args && args.filters) || {};
            if (isPtAckId(origFilters.propertyIds) && !filters.audit) {
              return Promise.resolve(
                origPtSearch.call(
                  Digit.PTService,
                  Object.assign({}, args || {}, {
                    filters: Object.assign({}, origFilters, { acknowledgementIds: origFilters.propertyIds }),
                  })
                )
              ).then(function (res2) {
                res2 = res2 || {};
                if (!Array.isArray(res2.Properties)) res2.Properties = [];
                res2.Properties.forEach(function (p) {
                  normalizeProperty(p);
                  rememberPtAck(p);
                });
                return res2;
              });
            }
            // Mutation details page searches by acknowledgementIds; if empty, fall back to propertyId.
            if (filters.acknowledgementIds && !filters.audit) {
              var ackId = filters.acknowledgementIds;
              var pid =
                ptAckToPropertyId[ackId] ||
                propertyIdFromAppDetailsPath() ||
                "";
              if (pid) {
                return Promise.resolve(
                  origPtSearch.call(
                    Digit.PTService,
                    Object.assign({}, a, { filters: { propertyIds: pid } })
                  )
                ).then(function (res3) {
                  res3 = res3 || {};
                  if (!Array.isArray(res3.Properties)) res3.Properties = [];
                  res3.Properties.forEach(function (p) {
                    normalizeProperty(p);
                    rememberPtAck(p);
                  });
                  return res3;
                });
              }
            }
            return res;
          })
          .catch(function () {
            // Only invent ACTIVE audit rows for audit searches — dummy props wipe mutation additionalDetails.
            if (filters.audit) {
              var fallback = ensureTwoActiveAuditProps([]);
              return { Properties: fallback, ResponseInfo: { status: "successful" } };
            }
            return { Properties: [], ResponseInfo: { status: "successful" } };
          });
      };
    }

    if (Digit.PTService && Digit.PTService.update && !Digit.PTService.__ptUpdateV36) {
      Digit.PTService.__ptUpdateV36 = true;
      var origPtUpdate = Digit.PTService.update.bind(Digit.PTService);
      var origPtSearchForUpdate = Digit.PTService.search && Digit.PTService.search.bind(Digit.PTService);
      Digit.PTService.update = function (details, tenantId) {
        var data = details || {};
        var prop = data.Property;
        if (!prop) return origPtUpdate(data, tenantId);

        // Citizen Update drops propertyId/ack after wizard leaves action=UPDATE/<pid>.
        // Backend _update searches only by those fields → "No criteria given for the property search".
        try {
          var src = null;
          try {
            src = JSON.parse(sessionStorage.getItem("propertyInitialObject") || "null");
          } catch (eInit) {
            src = null;
          }
          if (!src || !src.propertyId) {
            try {
              src = JSON.parse(sessionStorage.getItem("pt-property") || "null");
            } catch (ePt) {
              src = null;
            }
          }
          if ((!src || !src.propertyId) && typeof window !== "undefined") {
            var pm = String(window.location.href || "").match(/(PG-PT-[A-Za-z0-9-]+)/i);
            if (pm) src = { propertyId: pm[1] };
          }
          if (src) {
            if (!prop.propertyId && src.propertyId) prop.propertyId = src.propertyId;
            if (!prop.id && src.id) prop.id = src.id;
            if (!prop.accountId && src.accountId) prop.accountId = src.accountId;
            if (!prop.tenantId && src.tenantId) prop.tenantId = src.tenantId;
            var srcAck = src.acknowldgementNumber || src.acknowledgementNumber;
            if (srcAck && !prop.acknowldgementNumber && !prop.acknowledgementNumber) {
              prop.acknowldgementNumber = srcAck;
              prop.acknowledgementNumber = srcAck;
            }
          }
        } catch (eRestore) {}

        sanitizePropertyForUpdate(prop);
        var wf = Object.assign({}, prop.workflow || {});
        var action = wf.action;
        if (action && typeof action === "object") action = action.action;
        action = action ? String(action) : "";
        if (action === "undefined") action = "";

        var validWf = {
          OPEN: true,
          VERIFY: true,
          FORWARD: true,
          APPROVE: true,
          REJECT: true,
          SENDBACK: true,
          SENDBACKTOCITIZEN: true,
          REOPEN: true,
          PAY: true,
          INACTIVE_PROPERTY: true,
        };
        var startUi = {
          SUBMIT: true,
          EDIT: true,
          UPDATE: true,
          UPDATE_PROPERTY: true,
          PT_UPDATE: true,
        };

        var path = "";
        try {
          path = (window.location && window.location.pathname) || "";
        } catch (ePath) {}
        var onModifyForm = path.indexOf("/pt/modify-application") !== -1;
        var onEditApp = path.indexOf("/edit-application") !== -1;
        var cr = String(prop.creationReason || "");
        var appStatus = String(prop.applicationStatus || "");
        var selected = "";
        try {
          selected = sessionStorage.getItem("SELECTED_ACTION") || "";
        } catch (eSel) {}

        // edit-application is Update even if property still has creationReason MUTATION.
        var isMutation =
          !onEditApp &&
          !onModifyForm &&
          (cr === "MUTATION" || String(wf.businessService || "") === "PT.MUTATION");
        var isEditSubmit =
          onEditApp ||
          onModifyForm ||
          appStatus === "UPDATE" ||
          cr === "UPDATE" ||
          cr === "PT.UPDATE";

        if (!validWf[action] || startUi[action]) {
          if (isEditSubmit) {
            action = "OPEN";
            prop.creationReason = "UPDATE";
          } else if (validWf[selected] && selected !== "OPEN") {
            action = selected;
          } else if (!action || startUi[action]) {
            action = "OPEN";
          }
        }

        var bs = wf.businessService;
        if (isEditSubmit && action === "OPEN") {
          bs = "PT.UPDATE";
          prop.creationReason = "UPDATE";
        } else if (!bs || String(bs).indexOf("PT") !== 0) {
          if (prop.creationReason === "MUTATION") bs = "PT.MUTATION";
          else if (prop.creationReason === "UPDATE") bs = "PT.UPDATE";
          else bs = "PT.CREATE";
        }
        if (prop.status === "INWORKFLOW" && prop.creationReason === "CREATE" && action !== "OPEN") bs = "PT.CREATE";

        wf.action = action;
        wf.businessService = bs;
        wf.moduleName = wf.moduleName && String(wf.moduleName).indexOf("PT") === 0 ? wf.moduleName : "PT";
        wf.comment = wf.comment || " ";
        wf.tenantId = wf.tenantId || prop.tenantId || cityTenant();
        wf.businessId = wf.businessId || prop.acknowldgementNumber || prop.acknowledgementNumber;
        var assignes = Array.isArray(wf.assignes) ? wf.assignes : [];
        wf.assignes = assignes
          .map(function (a) {
            if (!a) return null;
            if (typeof a === "string") return { uuid: a };
            var uuid = a.uuid || a.id;
            return uuid ? { uuid: uuid } : null;
          })
          .filter(Boolean);
        // Mutation FORWARD → FIELDVERIFIED (PAY by citizen/PT_CEMP). Assigning PT_APPROVER
        // causes INVALID_ASSIGNEE (UI was showing that uuid as the red error).
        if ((bs === "PT.MUTATION" || isMutation) && action === "FORWARD") {
          wf.assignes = [];
        }
        delete wf.state;
        delete wf.nextActions;
        delete wf.roles;
        delete wf.assigneeRoles;
        delete wf.isTerminateState;
        delete wf.uuid;
        prop.workflow = wf;

        // P1: APPROVE must leave property ACTIVE (not stuck INWORKFLOW).
        if (action === "APPROVE") {
          prop.status = "ACTIVE";
          try {
            prop.applicationStatus = "APPROVED";
            if (prop.additionalDetails && typeof prop.additionalDetails === "object") {
              prop.additionalDetails = Object.assign({}, prop.additionalDetails, {
                applicationStatus: "APPROVED",
              });
            }
          } catch (eAppSt) {}
        }

        var pid = prop.propertyId || "";
        var startKey = pid && action === "OPEN" && String(bs) === "PT.UPDATE" ? "PT.UPDATE:" + pid : "";

        function asSuccess(found) {
          var ok = {
            Properties: [found],
            ResponseInfo: { status: "successful", apiId: "Rainmaker" },
          };
          if (startKey) ptStartUpdateCache[startKey] = ok;
          return ok;
        }

        function markActiveInResponse(res) {
          if (!res || !Array.isArray(res.Properties)) return res;
          res.Properties.forEach(function (p) {
            if (p && String(p.status || "").toUpperCase() === "INWORKFLOW") p.status = "ACTIVE";
          });
          return res;
        }

        function forceActiveAfterApprove(res) {
          var found = res && res.Properties && res.Properties[0];
          if (!found || String(found.status || "").toUpperCase() === "ACTIVE") {
            return markActiveInResponse(res);
          }
          var fix = Object.assign({}, found);
          sanitizePropertyForUpdate(fix);
          fix.status = "ACTIVE";
          fix.applicationStatus = "APPROVED";
          // Workflow already terminated after APPROVE — status-only sync.
          delete fix.workflow;
          return Promise.resolve(origPtUpdate({ Property: fix }, tenantId))
            .then(function (res2) {
              clearPtWfCache();
              return markActiveInResponse(res2 || res);
            })
            .catch(function () {
              return markActiveInResponse(res);
            });
        }

        function searchExistingUpdate() {
          var tid = prop.tenantId || tenantId || cityTenant();
          if (!origPtSearchForUpdate || !pid) return Promise.resolve(null);
          return Promise.resolve(origPtSearchForUpdate({ tenantId: tid, filters: { propertyIds: pid } }))
            .then(function (res) {
              var found = res && res.Properties && res.Properties[0];
              if (found && found.creationReason === "UPDATE" && String(found.status || "").toUpperCase() === "INWORKFLOW") {
                return asSuccess(found);
              }
              return null;
            })
            .catch(function () {
              return null;
            });
        }

        if (startKey && ptStartUpdateCache[startKey]) {
          return Promise.resolve(ptStartUpdateCache[startKey]);
        }
        if (startKey && ptStartUpdateInflight[startKey]) {
          return ptStartUpdateInflight[startKey];
        }

        var alreadyInUpdate =
          startKey &&
          String(prop.status || "").toUpperCase() === "INWORKFLOW" &&
          (cr === "UPDATE" || cr === "PT.UPDATE" || appStatus === "UPDATE");

        var pending = (alreadyInUpdate ? searchExistingUpdate() : Promise.resolve(null)).then(function (existing) {
          if (existing) return existing;
          return origPtUpdate(data, tenantId).then(function (res) {
            clearPtWfCache();
            if (startKey) ptStartUpdateCache[startKey] = res;
            if (action === "APPROVE") return forceActiveAfterApprove(res);
            return res;
          });
        });

        var p = pending.catch(function (err) {
          try {
            var errors = err && err.response && err.response.data && err.response.data.Errors;
            var msg = errors && errors[0] && errors[0].message;
            if (msg && String(msg).indexOf("not found in config") !== -1) {
              errors[0].message =
                "This action is not allowed in the current workflow state. Refresh the page and use the action shown after reload.";
            }
          } catch (e) {}
          clearPtWfCache();
          if (!startKey) return Promise.reject(err);
          return searchExistingUpdate().then(function (ok) {
            if (ok) return ok;
            return Promise.reject(err);
          });
        });

        if (startKey) {
          ptStartUpdateInflight[startKey] = p.finally(function () {
            delete ptStartUpdateInflight[startKey];
          });
          return ptStartUpdateInflight[startKey];
        }
        return p;
      };
    }

    wrapPtBillService();

    if (Digit.UserService && Digit.UserService.employeeSearch && !Digit.UserService.__ptEmpSearchV18) {
      Digit.UserService.__ptEmpSearchV18 = true;
      var origEmpSearch = Digit.UserService.employeeSearch.bind(Digit.UserService);
      Digit.UserService.employeeSearch = function (tenantId, filters) {
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        var f = Object.assign({}, filters || {});
        return Promise.resolve(origEmpSearch(tid, f))
          .then(function (d) {
            d = d || {};
            if (!Array.isArray(d.Employees)) d.Employees = [];
            return d;
          })
          .catch(function () {
            return { Employees: [] };
          });
      };
    }

    return true;
  }

  function patchPtUi() {
    if (!window.Digit) return false;
    if (Digit.Hooks && Digit.Hooks.useEmployeeSearch && !Digit.Hooks.__ptEmpHookV18) {
      Digit.Hooks.__ptEmpHookV18 = true;
      var origUseEmp = Digit.Hooks.useEmployeeSearch;
      Digit.Hooks.useEmployeeSearch = function (tenantId, filters, config) {
        filters = Object.assign({}, filters || {});
        var roles = filters.roles;
        if (Array.isArray(roles)) {
          filters.roles = roles
            .map(function (r) {
              if (r && typeof r === "object") return { code: r.code || r.name || "" };
              return { code: String(r || "") };
            })
            .filter(function (r) {
              return r.code;
            });
        } else if (typeof roles === "string") {
          filters.roles = roles
            .split(",")
            .filter(Boolean)
            .map(function (c) {
              return { code: c };
            });
        } else {
          delete filters.roles;
        }
        config = Object.assign({ retry: 0 }, config || {});
        try {
          var result = origUseEmp(tenantId, filters, config);
          if (result) {
            result.data = result.data || { Employees: [] };
            if (!Array.isArray(result.data.Employees)) result.data.Employees = [];
            if (result.isError) {
              result.isError = false;
              result.error = null;
            }
          }
          return result;
        } catch (e) {
          return { data: { Employees: [] }, isLoading: false, isError: false, error: null };
        }
      };
    }

    var R = window.React || window.ReactDOM;
    if (R && R.createElement && !R.__ptUiPatchedV41) {
      R.__ptUiPatchedV41 = true;
      if (R.cloneElement) {
        var origClone = R.cloneElement.bind(R);
        R.cloneElement = function (element) {
          if (element == null) return null;
          return origClone.apply(R, arguments);
        };
      }
      if (R.createElement) {
        var origCE = R.createElement.bind(R);
        window.__upyogCE = origCE;
        R.createElement = function (type, props) {
          if (props && typeof props.pattern === "string" && props.pattern.indexOf("/") === 0) {
            var cleanPat = sanitizeHtmlPattern(props.pattern);
            if (cleanPat !== props.pattern) {
              props = Object.assign({}, props, { pattern: cleanPat });
              var argsPat = [type, props];
              for (var pi = 2; pi < arguments.length; pi++) argsPat.push(arguments[pi]);
              return origCE.apply(R, argsPat);
            }
          }
          // Assess Property FY radios: Digit RadioButtons need isPTFlow + .code or checked never sticks.
          if (
            props &&
            props.optionsKey === "name" &&
            Array.isArray(props.options) &&
            props.options.length &&
            typeof props.onSelect === "function" &&
            !props.__upyogFyRadio
          ) {
            var fy0 = props.options[0];
            var fyLabel0 = fy0 && (fy0.name || fy0.code || fy0.finYearRange);
            var fyLike =
              fy0 &&
              (fy0.module === "PT" ||
                /^\d{4}-\d{2}$/.test(String(fyLabel0 || "")) ||
                /^\d{4}-\d{2}$/.test(String(fy0.finYearRange || "")));
            if (fyLike) {
              var fyOpts = props.options.map(function (y) {
                if (!y || typeof y !== "object") return y;
                var label = y.name || y.code || y.finYearRange || y.id;
                if (!label) return y;
                return Object.assign({}, y, { name: String(label), code: String(y.code || label) });
              });
              var fySel = props.selectedOption;
              if (fySel && typeof fySel === "object") {
                var selLabel = fySel.name || fySel.code || fySel.finYearRange;
                if (selLabel) {
                  fySel = Object.assign({}, fySel, {
                    name: String(selLabel),
                    code: String(fySel.code || selLabel),
                  });
                }
              }
              var nextFy = Object.assign({}, props, {
                options: fyOpts,
                selectedOption: fySel,
                isPTFlow: true,
                __upyogFyRadio: true,
              });
              var argsFy = [type, nextFy];
              for (var fi = 2; fi < arguments.length; fi++) argsFy.push(arguments[fi]);
              return origCE.apply(R, argsFy);
            }
          }
          if (props && props.id === "fieldInspector" && !Array.isArray(props.option)) {
            var next = Object.assign({}, props, { option: [] });
            var args = [type, next];
            for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
            return origCE.apply(R, args);
          }
          if (props && Object.prototype.hasOwnProperty.call(props, "options") && !Array.isArray(props.options)) {
            var nextOpts = Object.assign({}, props, { options: [] });
            var argsOpts = [type, nextOpts];
            for (var oi = 2; oi < arguments.length; oi++) argsOpts.push(arguments[oi]);
            return origCE.apply(R, argsOpts);
          }
          if (props && props.taxHeadEstimatesCalculation) {
            var th = props.taxHeadEstimatesCalculation;
            if (typeof th !== "object" || !Array.isArray(th.taxHeadEstimates) || th.taxHeadEstimates.length < 7) {
              var nextTh = Object.assign({}, props, { taxHeadEstimatesCalculation: safePtCalculation({ Calculation: [th] }).Calculation[0] });
              var argsTh = [type, nextTh];
              for (var ti = 2; ti < arguments.length; ti++) argsTh.push(arguments[ti]);
              return origCE.apply(R, argsTh);
            }
          }
          if (props && props.optionKey === "action" && typeof props.onSelect === "function" && !props.__ptMenuWrapped) {
            var origSelect = props.onSelect;
            var wrapped = function (opt) {
              var obj = opt;
              if (typeof opt === "string") obj = { action: opt };
              else if (opt && !opt.action && opt[props.optionKey]) obj = Object.assign({}, opt, { action: opt[props.optionKey] });
              if (obj && (obj.action === "INACTIVE_PROPERTY" || obj.action === "PT_INACTIVE_PROPERTY")) {
                obj = Object.assign({}, obj, { isTerminateState: true, assigneeRoles: [] });
              }
              try {
                sessionStorage.setItem("SELECTED_ACTION", (obj && obj.action) || "");
              } catch (e) {}
              return origSelect(obj);
            };
            var nextMenu = Object.assign({}, props, { onSelect: wrapped, __ptMenuWrapped: true });
            var argsMenu = [type, nextMenu];
            for (var j = 2; j < arguments.length; j++) argsMenu.push(arguments[j]);
            return origCE.apply(R, argsMenu);
          }
          if (props && props.formData && !props.__ptMutateFormV32) {
            var mutPath = "";
            try {
              mutPath = (window.location && window.location.pathname) || "";
            } catch (ePath) {}
            if (mutPath.indexOf("/employee/pt/property-mutate") !== -1) {
              var fd = props.formData;
              var origProp = fd.originalData || (fd.searchResult && fd.searchResult.property) || {};
              if (!Array.isArray(origProp.owners)) origProp.owners = [];
              var nextFd = Object.assign({}, fd, {
                originalData: origProp,
                searchResult: fd.searchResult && fd.searchResult.property ? fd.searchResult : { property: origProp },
              });
              var nextMut = Object.assign({}, props, {
                formData: nextFd,
                userType: props.userType || "employee",
                __ptMutateFormV32: true,
              });
              var argsMut = [type, nextMut];
              for (var mi = 2; mi < arguments.length; mi++) argsMut.push(arguments[mi]);
              return origCE.apply(R, argsMut);
            }
          }
          if (props && Array.isArray(props.option) && props.optionKey === "i18nKey" && !props.__ptDropV35) {
            var dropPath = "";
            try {
              dropPath = (window.location && window.location.pathname) || "";
            } catch (eDrop) {}
            if (dropPath.indexOf("/employee/pt/property-mutate") !== -1) {
              var opts = props.option;
              var sel = props.selected;
              if (sel && typeof sel === "object" && !sel[props.optionKey]) {
                var code = sel.code || sel.value;
                for (var di = 0; di < opts.length; di++) {
                  if (opts[di] && (opts[di].code === code || opts[di].value === code)) {
                    sel = opts[di];
                    break;
                  }
                }
              }
              var nextDrop = Object.assign({}, props, { selected: sel, __ptDropV35: true });
              var argsDrop = [type, nextDrop];
              for (var dj = 2; dj < arguments.length; dj++) argsDrop.push(arguments[dj]);
              return origCE.apply(R, argsDrop);
            }
          }
          if (props && props.formData) {
            var fdSafe = Object.assign({}, props.formData);
            var origSafe = fdSafe.originalData || (fdSafe.searchResult && fdSafe.searchResult.property) || {};
            if (!origSafe || typeof origSafe !== "object") origSafe = {};
            origSafe = Object.assign({}, origSafe);
            if (!Array.isArray(origSafe.owners) || !origSafe.owners.length) origSafe.owners = [dummyPtOwner()];
            origSafe.owners = origSafe.owners.filter(Boolean).map(function (ow) {
              ow = Object.assign({}, ow);
              if (!ow.ownerType) ow.ownerType = "NONE";
              if (!Array.isArray(ow.documents) || !ow.documents[0]) {
                ow.documents = [{ documentType: "NA", documentUid: "NA", fileStoreId: "NA" }];
              }
              return ow;
            });
            origSafe.ownershipCategory = origSafe.ownershipCategory || "INDIVIDUAL.SINGLEOWNER";
            fdSafe.originalData = origSafe;
            if (!fdSafe.searchResult || !fdSafe.searchResult.property) fdSafe.searchResult = { property: origSafe };
            props = Object.assign({}, props, { formData: fdSafe });
            var argsFd = [type, props];
            for (var fi = 2; fi < arguments.length; fi++) argsFd.push(arguments[fi]);
            try {
              return origCE.apply(R, argsFd);
            } catch (ceErr) {
              return origCE("div", { className: "pt-form-guard" }, null);
            }
          }
          try {
            return origCE.apply(R, arguments);
          } catch (ceErr2) {
            try {
              if (String(window.location.pathname || "").indexOf("/pt/") !== -1) {
                sessionStorage.setItem("PT_LAST_CRASH", String((ceErr2 && ceErr2.stack) || ceErr2).slice(0, 4000));
                return origCE("div", { className: "pt-render-guard" }, null);
              }
            } catch (eRemember) {}
            throw ceErr2;
          }
        };
      }
      if (R.useEffect && !R.__ptEffectV40) {
        R.__ptEffectV40 = true;
        var origEff = R.useEffect.bind(R);
        R.useEffect = function (fn, deps) {
          if (typeof fn !== "function") return origEff(fn, deps);
          return origEff(function () {
            try {
              return fn.apply(this, arguments);
            } catch (eEff) {
              try {
                if (String(window.location.pathname || "").indexOf("/pt/") !== -1) {
                  sessionStorage.setItem("PT_LAST_CRASH", String((eEff && eEff.stack) || eEff).slice(0, 4000));
                  return;
                }
              } catch (e2) {}
              throw eEff;
            }
          }, deps);
        };
      }
    }
    return true;
  }

  function sanitizeOwnerDocs(docs) {
    if (!Array.isArray(docs)) return [];
    return docs
      .filter(function (d) {
        return d && typeof d === "object";
      })
      .map(function (d) {
        var next = Object.assign({}, d);
        if (!next.fileStoreId && next.documentUid && next.documentUid !== "NA") {
          next.fileStoreId = next.documentUid;
        }
        return next;
      })
      .filter(function (d) {
        if (!d.fileStoreId || d.fileStoreId === "NA") return false;
        if (d.documentType === "NA") return false;
        return true;
      });
  }

  function sanitizePropertyForUpdate(prop) {
    if (!prop || typeof prop !== "object") return prop;
    if (Array.isArray(prop.owners)) {
      prop.owners = prop.owners.map(function (o) {
        if (!o) return o;
        o = Object.assign({}, o);
        o.documents = sanitizeOwnerDocs(o.documents);
        return o;
      });
    }
    if (Array.isArray(prop.documents)) {
      prop.documents = sanitizeOwnerDocs(prop.documents);
    }
    return prop;
  }

  function normalizeProperty(p) {
    if (!p || typeof p !== "object") return p;
    if (typeof p.ownershipCategory !== "string") {
      p.ownershipCategory = (p.ownershipCategory && p.ownershipCategory.code) || "INDIVIDUAL.SINGLEOWNER";
    }
    if (!Array.isArray(p.owners)) p.owners = p.owners ? [p.owners] : [];
    p.owners.forEach(function (o) {
      if (!o) return;
      // Digit does owner.gender.toLowerCase() — null/non-string crashes details page.
      if (!o.gender || typeof o.gender !== "string") o.gender = "MALE";
      if (!o.relationship || typeof o.relationship !== "string") o.relationship = "FATHER";
      if (o.fatherOrHusbandName == null || o.fatherOrHusbandName === "") o.fatherOrHusbandName = "NA";
      if (!o.ownerType) o.ownerType = "NONE";
      if (!o.name) o.name = "NA";
      if (!Array.isArray(o.documents)) o.documents = [];
      o.documents = sanitizeOwnerDocs(o.documents);
      if (!o.documents.length) {
        o.documents = [{ documentUid: "NA", documentType: "NA", fileStoreId: "NA" }];
      }
    });
    if (!Array.isArray(p.units)) p.units = [];
    if (!Array.isArray(p.documents)) p.documents = [];
    p.documents = sanitizeOwnerDocs(p.documents);
    if (!p.address) p.address = {};
    // Institutional mutation details read institution.* without null guards.
    if (String(p.ownershipCategory).indexOf("INSTITUTIONAL") === 0) {
      var inst = p.institution && typeof p.institution === "object" ? p.institution : {};
      var auth = (p.owners[0] && p.owners[0].name) || "NA";
      p.institution = {
        id: inst.id || null,
        tenantId: inst.tenantId || p.tenantId || cityTenant(),
        name: inst.name || "NA",
        type: typeof inst.type === "string" ? inst.type : (inst.type && inst.type.code) || "OTHERSPRIVATEINSTITUITION",
        designation: inst.designation || "NA",
        nameOfAuthorizedPerson: inst.nameOfAuthorizedPerson || auth,
        additionalDetails: inst.additionalDetails || null,
      };
    }
    if (!p.additionalDetails || typeof p.additionalDetails !== "object") p.additionalDetails = {};
    // Keep Digit typo + correct spellings so mutation details ack lookup works.
    if (p.acknowldgementNumber && !p.acknowledgementNumber) p.acknowledgementNumber = p.acknowldgementNumber;
    if (p.acknowledgementNumber && !p.acknowldgementNumber) p.acknowldgementNumber = p.acknowledgementNumber;
    restoreMutationAdditionalDetails(p);
    cacheMutationAdditionalDetails(p);
    rememberPtAck(p);
    return p;
  }

  function stubPtTrackApis() {
    if (!window.Digit) return false;
    if (Digit.PTService && !Digit.PTService.__cfStubV22) {
      Digit.PTService.__cfStubV22 = true;
      Digit.PTService.cfsearch = function () {
        return Promise.resolve({ Service: [] });
      };
    }
    if (Digit.PaymentService && Digit.PaymentService.searchBill && !Digit.PaymentService.__billSafeV22) {
      Digit.PaymentService.__billSafeV22 = true;
      var origBill = Digit.PaymentService.searchBill.bind(Digit.PaymentService);
      Digit.PaymentService.searchBill = function () {
        return Promise.resolve(origBill.apply(this, arguments))
          .then(function (d) {
            d = d || {};
            if (!Array.isArray(d.Bill)) d.Bill = [];
            return d;
          })
          .catch(function () {
            return { Bill: [] };
          });
      };
    }
    if (Digit.Hooks && Digit.Hooks.pt && Digit.Hooks.pt.usePropertySearch && !Digit.Hooks.pt.__searchSafeV22) {
      Digit.Hooks.pt.__searchSafeV22 = true;
      var origSearch = Digit.Hooks.pt.usePropertySearch;
      Digit.Hooks.pt.usePropertySearch = function (args, config) {
        var result = origSearch(args, Object.assign({ retry: 0 }, config || {}));
        if (result) {
          if (result.data && Array.isArray(result.data.Properties)) {
            result.data.Properties.forEach(normalizeProperty);
          }
          if (result.isError) {
            result.isError = false;
            result.error = null;
            if (!result.data) result.data = { Properties: [] };
          }
        }
        return result;
      };
    }
    if (Digit.Hooks && Digit.Hooks.pt && Digit.Hooks.pt.useServiceSearchCF && !Digit.Hooks.pt.__cfHookV22) {
      Digit.Hooks.pt.__cfHookV22 = true;
      Digit.Hooks.pt.useServiceSearchCF = function () {
        return { isLoading: false, error: null, data: { Service: [] }, revalidate: function () {} };
      };
    }
    if (Digit.Hooks && Digit.Hooks.useFeedBackSearch && !Digit.Hooks.__fbStubV22) {
      Digit.Hooks.__fbStubV22 = true;
      Digit.Hooks.useFeedBackSearch = function () {
        return { isLoading: false, error: null, data: { Service: [] }, revalidate: function () {} };
      };
    }
    wrapPtAssessmentHooks();
    return true;
  }

  function emptyTaxHeads() {
    var heads = [];
    for (var i = 0; i < 8; i++) {
      heads.push({ taxHeadCode: "PT_HEAD_" + i, estimateAmount: 0, category: "TAX" });
    }
    heads[5].taxHeadCode = "PT_TIME_REBATE";
    heads[6].taxHeadCode = "PT_TIME_PENALTY";
    return heads;
  }

  function emptyPtAppSection(title) {
    return {
      title: title || " ",
      values: [
        { title: "", value: "" },
        { title: "", value: "" },
      ],
      additionalDetails: { owners: [], documents: [{ values: [] }] },
    };
  }

  function padPtApplicationDetail(data) {
    if (!data || typeof data !== "object") {
      data = { applicationDetails: [], applicationData: { units: [], owners: [] } };
    }
    if (!Array.isArray(data.applicationDetails)) data.applicationDetails = [];
    var defaultTitles = [" ", " ", "PT_OWNERSHIP_INFO_SUB_HEADER"];
    while (data.applicationDetails.length < 3) {
      data.applicationDetails.push(emptyPtAppSection(defaultTitles[data.applicationDetails.length]));
    }
    data.applicationDetails.forEach(function (sec, idx) {
      if (!sec || typeof sec !== "object") {
        data.applicationDetails[idx] = emptyPtAppSection(idx === 2 ? "PT_OWNERSHIP_INFO_SUB_HEADER" : " ");
        sec = data.applicationDetails[idx];
      }
      if (!Array.isArray(sec.values)) sec.values = [];
      while (sec.values.length < 2) sec.values.push({ title: "", value: "" });
      if (!sec.additionalDetails || typeof sec.additionalDetails !== "object") {
        sec.additionalDetails = { owners: [], documents: [{ values: [] }] };
      } else {
        if (!Array.isArray(sec.additionalDetails.owners)) sec.additionalDetails.owners = [];
        if (!Array.isArray(sec.additionalDetails.documents)) {
          sec.additionalDetails.documents = [{ values: [] }];
        }
        if (!sec.additionalDetails.documents[0] || typeof sec.additionalDetails.documents[0] !== "object") {
          sec.additionalDetails.documents[0] = { values: [] };
        }
        if (!Array.isArray(sec.additionalDetails.documents[0].values)) {
          sec.additionalDetails.documents[0].values = [];
        }
      }
    });
    data.applicationData = data.applicationData || {};
    if (!Array.isArray(data.applicationData.units)) data.applicationData.units = [];
    if (!Array.isArray(data.applicationData.owners)) data.applicationData.owners = [];
    var oc = data.applicationData.ownershipCategory;
    if (typeof oc !== "string") {
      data.applicationData.ownershipCategory = (oc && oc.code) || "INDIVIDUAL.SINGLEOWNER";
    }
    data.applicationData.owners.forEach(function (o) {
      if (!o) return;
      if (!Array.isArray(o.documents) || !o.documents.length || !o.documents[0]) {
        o.documents = [{ documentUid: "NA", documentType: "NA", fileStoreId: "NA" }];
      }
    });
    var hasOwn = data.applicationDetails.some(function (s) {
      return s && s.title === "PT_OWNERSHIP_INFO_SUB_HEADER";
    });
    if (!hasOwn) data.applicationDetails.push(emptyPtAppSection("PT_OWNERSHIP_INFO_SUB_HEADER"));
    if (typeof data.transformToAppDetailsForEmployee !== "function") {
      data.transformToAppDetailsForEmployee = transformPtPropertyToAppDetails;
    }
    return data;
  }

  function mapPtDocsForUi(prop) {
    var seen = {};
    var out = [];
    function pushDoc(d) {
      if (!d || !d.fileStoreId || d.fileStoreId === "NA") return;
      if (seen[d.fileStoreId + "|" + (d.documentType || "")]) return;
      seen[d.fileStoreId + "|" + (d.documentType || "")] = true;
      out.push({
        title: d.documentType || "Document",
        documentType: d.documentType || "Document",
        documentUid: d.documentUid || d.fileStoreId,
        fileStoreId: d.fileStoreId,
        status: d.status || "ACTIVE",
      });
    }
    (Array.isArray(prop && prop.documents) ? prop.documents : []).forEach(pushDoc);
    (Array.isArray(prop && prop.owners) ? prop.owners : []).forEach(function (o) {
      (Array.isArray(o && o.documents) ? o.documents : []).forEach(pushDoc);
    });
    return out;
  }

  function transformPtPropertyToAppDetails(args) {
    try {
      var prop = (args && args.property) || {};
      prop = normalizeProperty(Object.assign({}, prop));
      var owners = Array.isArray(prop.owners) ? prop.owners.filter(Boolean) : [];
      owners.forEach(function (o) {
        if (!o.ownerType) o.ownerType = "NONE";
        if (!Array.isArray(o.documents) || !o.documents[0]) {
          o.documents = [{ documentType: "NA", documentUid: "NA", fileStoreId: "NA" }];
        }
      });
      var addr = prop.address || {};
      var docValues = mapPtDocsForUi(prop);
      // Keep raw docs on property so alternate Digit render paths (PT_COMMON_DOCS) see them.
      if ((!Array.isArray(prop.documents) || !prop.documents.length) && docValues.length) {
        prop.documents = docValues.map(function (d) {
          return {
            documentType: d.documentType,
            documentUid: d.documentUid,
            fileStoreId: d.fileStoreId,
            status: d.status,
          };
        });
      }
      var ownerCards = owners.map(function (o) {
        var ownerType = o.ownerType || "NONE";
        return {
          status: o.status || "ACTIVE",
          name: o.name || "NA",
          mobileNumber: o.mobileNumber || "",
          fatherOrHusbandName: o.fatherOrHusbandName || "NA",
          relationship: o.relationship || "FATHER",
          ownerType: ownerType,
          documents: o.documents,
          values: [
            { title: "PT_OWNERSHIP_INFO_NAME", value: o.name || "NA" },
            { title: "PT_OWNERSHIP_INFO_GENDER", value: o.gender || "NA" },
            { title: "PT_OWNERSHIP_INFO_MOBILE_NO", value: o.mobileNumber || "NA" },
            { title: "PT_SEARCHPROPERTY_TABEL_GUARDIANNAME", value: o.fatherOrHusbandName || "NA" },
            { title: "PT_FORM3_RELATIONSHIP", value: o.relationship || "NA" },
            { title: "PT_OWNERSHIP_INFO_USER_CATEGORY", value: "COMMON_MASTERS_OWNERTYPE_" + ownerType },
          ],
        };
      });
      var docsBlock = [{ values: docValues }];
      return [
        {
          title: "PT_PROPERTY_ADDRESS_SUB_HEADER",
          asSectionHeader: true,
          values: [
            { title: "PT_PROPERTY_ADDRESS_PINCODE", value: addr.pincode || "NA" },
            { title: "PT_PROPERTY_ADDRESS_CITY", value: addr.city || "NA" },
            {
              title: "PT_PROPERTY_ADDRESS_MOHALLA",
              value: (addr.locality && (addr.locality.name || addr.locality.code)) || "NA",
            },
            { title: "PT_PROPERTY_ADDRESS_STREET_NAME", value: addr.street || "NA" },
            { title: "PT_PROPERTY_ADDRESS_HOUSE_NO", value: addr.doorNo || "NA" },
          ],
          // Digit shows PT_NO_DOCUMENTS from this address-section documents block.
          additionalDetails: { owners: [], documents: docsBlock },
        },
        {
          title: "PT_ASSESMENT_INFO_SUB_HEADER",
          asSectionHeader: true,
          values: [
            { title: "PT_ASSESMENT_INFO_TYPE_OF_BUILDING", value: prop.propertyType || "NA" },
            { title: "PT_ASSESMENT_INFO_USAGE_TYPE", value: prop.usageCategory || "NA" },
            { title: "PT_ASSESMENT_INFO_PLOT_SIZE", value: prop.landArea || "NA" },
            { title: "PT_ASSESMENT_INFO_NO_OF_FLOOR", value: prop.noOfFloors || "NA" },
          ],
          additionalDetails: { owners: [], documents: [{ values: [] }] },
        },
        {
          title: "PT_OWNERSHIP_INFO_SUB_HEADER",
          asSectionHeader: true,
          values: [],
          additionalDetails: {
            owners: ownerCards.length ? ownerCards : [Object.assign({}, dummyPtOwner(), { status: "ACTIVE", values: [] })],
            documents: docsBlock,
          },
        },
      ];
    } catch (e) {
      return padPtApplicationDetail(null).applicationDetails;
    }
  }

  function wrapPtMutationCalc() {
    var ps = window.Digit && Digit.PTService;
    if (!ps || ps.__mutCalcV59) return;
    ps.__mutCalcV59 = true;
    var orig = typeof ps.ptCalculateMutation === "function" ? ps.ptCalculateMutation.bind(ps) : null;
    ps.ptCalculateMutation = function (payload, tenantId) {
      var tid = hasCity(tenantId) ? tenantId : cityTenant();
      var prop = (payload && payload.Property) || payload || {};
      try {
        // Ensure calc criteria match seeded MutationBillingSlab rows.
        if (!prop.ownershipCategory) prop.ownershipCategory = "INDIVIDUAL.SINGLEOWNER";
        prop.additionalDetails = Object.assign({}, prop.additionalDetails || {});
        if (prop.additionalDetails.marketValue == null || prop.additionalDetails.marketValue === "") {
          prop.additionalDetails.marketValue =
            prop.additionalDetails.documentValue != null ? prop.additionalDetails.documentValue : 0;
        }
        if (prop.additionalDetails.documentValue == null) {
          prop.additionalDetails.documentValue = prop.additionalDetails.marketValue;
        }
      } catch (eNorm) {}
      var body = { RequestInfo: payRequestInfo(), Property: prop };
      var run;
      if (orig) {
        run = orig({ Property: prop }, tid);
      } else {
        run = fetch("/pt-calculator-v2/propertytax/mutation/_calculate?tenantId=" + encodeURIComponent(tid), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().catch(function () {
            return {};
          });
        });
      }
      return Promise.resolve(run)
        .then(function (res) {
          // If API returned Errors, surface them (do not fake success with zeros).
          if (res && Array.isArray(res.Errors) && res.Errors.length) return Promise.reject(res);
          res = safePtCalculation(res);
          try {
            var ack = prop.acknowldgementNumber || prop.acknowlegmentNumber;
            var amt = (res.Calculation && res.Calculation[0] && res.Calculation[0].totalAmount) || 0;
            if (ack && !res[ack]) res[ack] = { totalAmount: amt };
          } catch (eAck) {}
          return res;
        });
    };
  }

  function safePtCalculation(data) {
    var calc = data && Array.isArray(data.Calculation) ? data.Calculation[0] : null;
    var heads = calc && Array.isArray(calc.taxHeadEstimates) ? calc.taxHeadEstimates.slice() : [];
    while (heads.length < 8) {
      heads.push({ taxHeadCode: "PT_HEAD_" + heads.length, estimateAmount: 0, category: "TAX" });
    }
    for (var i = 0; i < heads.length; i++) {
      if (!heads[i] || typeof heads[i] !== "object") {
        heads[i] = { taxHeadCode: "PT_HEAD_" + i, estimateAmount: 0, category: "TAX" };
      } else if (heads[i].estimateAmount == null || heads[i].estimateAmount === "") {
        heads[i].estimateAmount = 0;
      }
    }
    var out = Object.assign({}, data || {});
    out.Calculation = [
      Object.assign({}, calc || {}, {
        totalAmount: (calc && calc.totalAmount) || 0,
        taxAmount: (calc && calc.taxAmount) || 0,
        taxHeadEstimates: heads,
      }),
    ];
    return out;
  }

  function enrichOwnershipMdmsItem(item) {
    if (!item || typeof item !== "object") return item;
    if (!item.value && item.code) item.value = item.code;
    if (!item.code && item.value) item.code = item.value;
    if (!item.i18nKey && item.code) {
      var parts = String(item.code).split(".");
      item.i18nKey = "PT_OWNERSHIP_" + (parts[1] || parts[0]);
    }
    if (item.dropdownData && !Array.isArray(item.dropdownData)) item.dropdownData = [];
    return item;
  }

  var subOwnerShipCache = null;

  function ownershipListHasSubtypes(arr) {
    if (!arr || !arr.length) return false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].code && String(arr[i].code).indexOf(".") !== -1) return true;
    }
    return false;
  }

  function ensureParentOwnershipCodes(arr) {
    var seen = {};
    arr.forEach(function (item) {
      if (item && item.code) seen[item.code] = true;
    });
    ["INSTITUTIONALPRIVATE", "INSTITUTIONALGOVERNMENT"].forEach(function (code) {
      if (!seen[code]) {
        arr.push(enrichOwnershipMdmsItem({ code: code, value: code, name: code, active: true }));
      }
    });
  }

  function recoverSubOwnerShipCategory(d) {
    if (ownershipListHasSubtypes(subOwnerShipCache)) return subOwnerShipCache;
    var fromApi = null;
    if (Array.isArray(d) && d.length) fromApi = d;
    else if (d && d.PropertyTax && Array.isArray(d.PropertyTax.SubOwnerShipCategory) && d.PropertyTax.SubOwnerShipCategory.length) {
      fromApi = d.PropertyTax.SubOwnerShipCategory;
    }
    if (!fromApi || !fromApi.length) {
      try {
        var stored = sessionStorage.getItem("getSubPropertyOwnerShipCategory");
        if (stored) {
          var parsed = JSON.parse(stored);
          if (parsed && parsed.PropertyTax && Array.isArray(parsed.PropertyTax.SubOwnerShipCategory)) {
            fromApi = parsed.PropertyTax.SubOwnerShipCategory;
          } else if (Array.isArray(parsed) && parsed.length) fromApi = parsed;
        }
      } catch (e) {}
    }
    if (fromApi && fromApi.length) {
      var copy = [];
      fromApi.forEach(function (item) {
        if (!item || !item.code) return;
        copy.push(enrichOwnershipMdmsItem(Object.assign({}, item)));
      });
      if (!ownershipListHasSubtypes(copy)) return subOwnerShipCache;
      ensureParentOwnershipCodes(copy);
      subOwnerShipCache = copy;
      return copy;
    }
    return subOwnerShipCache;
  }

  function wrapPtAssessmentHooks() {
    if (!window.Digit) return;
    if (Digit.PTService && Digit.PTService.ptCalculationEstimate && !Digit.PTService.__ptCalcSvcV29) {
      Digit.PTService.__ptCalcSvcV29 = true;
      var origSvc = Digit.PTService.ptCalculationEstimate.bind(Digit.PTService);
      Digit.PTService.ptCalculationEstimate = function (payload, tenantId) {
        var body = payload;
        try {
          if (body && body.Assessment && body.Assessment.financialYear) {
            var fy = String(body.Assessment.financialYear);
            if (/^\d{2}-\d{2}$/.test(fy)) {
              body = JSON.parse(JSON.stringify(body));
              body.Assessment.financialYear = "20" + fy;
            }
          }
        } catch (e) {}
        return Promise.resolve(origSvc(body, tenantId))
          .then(function (res) {
            return safePtCalculation(res);
          })
          .catch(function () {
            return safePtCalculation(null);
          });
      };
    }
    if (!Digit.Hooks || !Digit.Hooks.pt) return;
    if (Digit.Hooks.pt.usePtCalculationEstimate && !Digit.Hooks.pt.__ptCalcSafeV29) {
      Digit.Hooks.pt.__ptCalcSafeV29 = true;
      var origCalc = Digit.Hooks.pt.usePtCalculationEstimate;
      Digit.Hooks.pt.usePtCalculationEstimate = function (tenantId) {
        var result = origCalc(tenantId);
        if (!result) {
          return {
            data: safePtCalculation(null),
            isLoading: false,
            isError: false,
            mutate: function () {},
          };
        }
        var origMutate = typeof result.mutate === "function" ? result.mutate.bind(result) : null;
        var mutate = function (vars, opts) {
          opts = opts || {};
          if (!origMutate) return;
          return origMutate(vars, {
            onSuccess: function (data, v) {
              if (opts.onSuccess) opts.onSuccess(safePtCalculation(data), v);
            },
            onError: function (err, v) {
              if (opts.onError) opts.onError(err, v);
            },
          });
        };
        return Object.assign({}, result, {
          data: safePtCalculation(result.data),
          isError: false,
          error: null,
          mutate: mutate,
        });
      };
    }
    if (Digit.Hooks.pt.usePropertyMDMS && !Digit.Hooks.pt.__ptMdmsSafeV38) {
      Digit.Hooks.pt.__ptMdmsSafeV38 = true;
      var origPropMdms = Digit.Hooks.pt.usePropertyMDMS;
      // Callers like Units read every requested master (e.g. OccupancyType.map) without guards.
      var fillRequestedMasters = function (pt, masters) {
        if (!Array.isArray(masters)) return pt;
        masters.forEach(function (m) {
          if (typeof m === "string" && !Array.isArray(pt[m])) pt[m] = [];
        });
        return pt;
      };
      var ptMdmsPlaceholder = function (masters) {
        return { PropertyTax: fillRequestedMasters({ ChargeSlabs: [], MutationDocuments: [] }, masters) };
      };
      Digit.Hooks.pt.usePropertyMDMS = function () {
        var masters = arguments.length > 2 ? arguments[2] : null;
        try {
          var result = origPropMdms.apply(this, arguments);
          if (!result) {
            return {
              data:
                masters === "SubOwnerShipCategory"
                  ? undefined
                  : typeof masters === "string"
                    ? []
                    : ptMdmsPlaceholder(masters),
              isLoading: masters === "SubOwnerShipCategory",
              isError: false,
            };
          }
          var d = result.data;
          if (masters === "SubOwnerShipCategory") {
            var recovered = recoverSubOwnerShipCategory(d);
            if (ownershipListHasSubtypes(recovered)) {
              return Object.assign({}, result, { data: recovered, isError: false, error: null });
            }
            return Object.assign({}, result, { data: undefined, isError: false, error: null });
          }
          if (Array.isArray(d)) {
            d.forEach(enrichOwnershipMdmsItem);
            return Object.assign({}, result, { isError: false, error: null });
          }
          if (d && typeof d === "object") {
            if (d.PropertyTax && typeof d.PropertyTax === "object") {
              d.PropertyTax = Object.assign({}, d.PropertyTax);
              if (d.PropertyTax.ChargeSlabs != null && !Array.isArray(d.PropertyTax.ChargeSlabs)) {
                d.PropertyTax.ChargeSlabs = [];
              }
              if (!Array.isArray(d.PropertyTax.MutationDocuments)) {
                d.PropertyTax.MutationDocuments = [];
              }
              d.PropertyTax.MutationDocuments.forEach(function (doc) {
                if (!doc || typeof doc !== "object") return;
                if (!Array.isArray(doc.dropdownData)) doc.dropdownData = [];
              });
              if (Array.isArray(d.PropertyTax.SubOwnerShipCategory)) {
                d.PropertyTax.SubOwnerShipCategory.forEach(enrichOwnershipMdmsItem);
              }
              fillRequestedMasters(d.PropertyTax, masters);
            }
            return Object.assign({}, result, { data: d, isError: false, error: null });
          }
          return Object.assign({}, result, {
            data: typeof masters === "string" ? [] : ptMdmsPlaceholder(masters),
            isError: false,
            error: null,
          });
        } catch (e) {
          return {
            data:
              masters === "SubOwnerShipCategory"
                ? undefined
                : typeof masters === "string"
                  ? []
                  : ptMdmsPlaceholder(masters),
            isLoading: masters === "SubOwnerShipCategory",
            isError: false,
          };
        }
      };
    }
    if (Digit.Hooks.pt.useApplicationDetail && !Digit.Hooks.pt.__ptAppDetailV72) {
      Digit.Hooks.pt.__ptAppDetailV72 = true;
      // MUST return stable data refs — rebuilding detail every render froze Doc Verifier pages.
      var ptAppDetailCache = {};
      Digit.Hooks.pt.useApplicationDetail = function (tFn, tenantId, id, config, extraFilters) {
        try {
          config = Object.assign({ retry: 0, useErrorBoundary: false }, config || {});
          var userSelect = config.select;
          var tid = hasCity(tenantId) ? tenantId : cityTenant();
          var filters = Object.assign({}, typeof extraFilters === "object" && extraFilters ? extraFilters : {});
          if (isPtAckId(id)) {
            if (!filters.acknowledgementIds) filters.acknowledgementIds = id;
            delete filters.propertyIds;
          } else if (!filters.propertyIds && !filters.acknowledgementIds) {
            filters.propertyIds = id;
          }
          var search = Digit.Hooks.pt.usePropertySearch(
            { tenantId: tid, filters: filters },
            {
              retry: 0,
              useErrorBoundary: false,
              staleTime: config.staleTime != null ? config.staleTime : 30000,
              enabled: config.enabled !== false,
            }
          );
          var prop = null;
          try {
            var raw = search && search.data;
            if (raw && Array.isArray(raw.Properties) && raw.Properties[0]) prop = raw.Properties[0];
            else if (Array.isArray(raw) && raw[0]) prop = raw[0];
            else if (raw && raw[0]) prop = raw[0];
          } catch (eProp) {}
          if (!prop) {
            try {
              prop = JSON.parse(sessionStorage.getItem("pt-property") || "null");
            } catch (eSs) {
              prop = null;
            }
          }
          var loading = !!(search && search.isLoading);
          var adSig = "";
          try {
            var ad0 = prop && prop.additionalDetails;
            if (ad0 && typeof ad0 === "object") {
              adSig =
                String(ad0.marketValue != null ? ad0.marketValue : "") +
                "|" +
                String(ad0.documentNumber || "") +
                "|" +
                String(ad0.reasonForTransfer || "");
            }
          } catch (eAdSig) {}
          var sig =
            String(id || "") +
            "|" +
            (prop
              ? String(prop.propertyId || "") +
                "|" +
                String(prop.status || "") +
                "|" +
                String((prop.auditDetails && prop.auditDetails.lastModifiedTime) || "") +
                "|" +
                String(prop.acknowldgementNumber || prop.acknowledgementNumber || "") +
                "|" +
                adSig
              : "nop") +
            "|" +
            (loading ? "L" : "R");
          var cached = ptAppDetailCache[id];
          if (cached && cached.sig === sig) {
            return {
              isLoading: loading,
              isFetching: !!(search && search.isFetching),
              isError: false,
              error: null,
              data: cached.detail,
              revalidate: search && search.revalidate,
            };
          }
          if (!prop || typeof prop !== "object") {
            prop = Object.assign(dummyPtProperty(), {
              propertyId: id,
              acknowldgementNumber: id,
              tenantId: tid,
            });
          }
          rememberPtAck(prop);
          prop = normalizeProperty(Object.assign({}, prop));
          if (!prop.tenantId) prop.tenantId = tid;
          if (!prop.acknowldgementNumber && isPtAckId(id)) prop.acknowldgementNumber = id;
          if (prop.acknowldgementNumber && !prop.acknowledgementNumber) {
            prop.acknowledgementNumber = prop.acknowldgementNumber;
          }
          cacheMutationAdditionalDetails(prop);
          var detail = padPtApplicationDetail({
            tenantId: prop.tenantId || tid,
            applicationData: prop,
            additionalDetails: prop.additionalDetails || {},
            applicationDetails: transformPtPropertyToAppDetails({ property: prop, t: tFn }),
            transformToAppDetailsForEmployee: transformPtPropertyToAppDetails,
          });
          if (typeof userSelect === "function") {
            try {
              detail = userSelect(detail);
            } catch (userErr) {}
          }
          detail = padPtApplicationDetail(detail);
          // After Digit select/clone, keep mutation registration fields on applicationData.
          if (detail && detail.applicationData) {
            restoreMutationAdditionalDetails(detail.applicationData);
            cacheMutationAdditionalDetails(detail.applicationData);
            detail.additionalDetails = detail.applicationData.additionalDetails || detail.additionalDetails || {};
          }
          detail.transformToAppDetailsForEmployee = transformPtPropertyToAppDetails;
          ptAppDetailCache[id] = { sig: sig, detail: detail };
          return {
            isLoading: loading,
            isFetching: !!(search && search.isFetching),
            isError: false,
            error: null,
            data: detail,
            revalidate: search && search.revalidate,
          };
        } catch (e) {
          var fallback = padPtApplicationDetail({
            applicationData: { units: [], owners: [], acknowldgementNumber: id, propertyId: id, tenantId: tenantId },
          });
          fallback.transformToAppDetailsForEmployee = transformPtPropertyToAppDetails;
          return {
            data: fallback,
            isLoading: false,
            isError: false,
            error: null,
          };
        }
      };
    }
    if (Digit.Hooks.pt.usePropertySearch && !Digit.Hooks.pt.__ptAuditV39) {
      Digit.Hooks.pt.__ptAuditV39 = true;
      var origPropSearch = Digit.Hooks.pt.usePropertySearch;
      Digit.Hooks.pt.usePropertySearch = function (args, config) {
        config = Object.assign({}, config || {});
        var filters = (args && args.filters) || {};
        var userSelect = config.select;
        if (filters.audit) {
          config.select = function (raw) {
            var selected;
            try {
              if (typeof userSelect === "function") {
                var safeRaw = raw || { Properties: [] };
                if (!Array.isArray(safeRaw.Properties)) safeRaw = Object.assign({}, safeRaw, { Properties: [] });
                selected = userSelect(safeRaw);
              } else {
                selected = (raw && raw.Properties) || [];
              }
            } catch (selErr) {
              selected = (raw && raw.Properties) || [];
            }
            if (!Array.isArray(selected)) selected = [];
            if (!selected.length && raw && Array.isArray(raw.Properties) && raw.Properties.length) {
              selected = raw.Properties.slice();
            }
            selected = ensureTwoActiveAuditProps(selected);
            return selected;
          };
        }
        try {
          return origPropSearch.call(this, args, config);
        } catch (e) {
          return { data: { Properties: [] }, isLoading: false, isError: false, error: null };
        }
      };
    }
    if (Digit.Hooks.pt.usePTGenderMDMS && !Digit.Hooks.pt.__ptGenderV32) {
      Digit.Hooks.pt.__ptGenderV32 = true;
      var origGender = Digit.Hooks.pt.usePTGenderMDMS;
      Digit.Hooks.pt.usePTGenderMDMS = function () {
        var result = origGender.apply(this, arguments);
        if (!result) return { data: [], isLoading: false, isError: false };
        var data = result.data;
        if (data && !Array.isArray(data)) {
          data =
            data.GenderType ||
            (data["common-masters"] && data["common-masters"].GenderType) ||
            [];
        }
        if (!Array.isArray(data)) data = [];
        return Object.assign({}, result, { data: data, isError: false, error: null });
      };
    }
    if (Digit.Hooks.pt.useMDMS && !Digit.Hooks.pt.__ptFySafeV32) {
      Digit.Hooks.pt.__ptFySafeV32 = true;
      var origPtMdms = Digit.Hooks.pt.useMDMS;
      Digit.Hooks.pt.useMDMS = function () {
        var result = origPtMdms.apply(this, arguments);
        if (!result || !result.data) return result;
        try {
          var egf = result.data["egf-master"];
          if (egf) {
            var years = Array.isArray(egf.FinancialYear) ? egf.FinancialYear : [];
            egf.FinancialYear = years
              .filter(Boolean)
              .map(function (y) {
                if (typeof y === "string") return { name: y, code: y, module: "PT" };
                var next = Object.assign({}, y);
                next.name = next.name || next.code || next.finYearRange || next.id;
                next.code = next.code || next.name;
                return next;
              })
              .filter(function (y) {
                return y && y.name;
              });
          }
        } catch (e) {}
        return result;
      };
    }
    if (Digit.Hooks.useFetchBillsForBuissnessService && !Digit.Hooks.__ptFetchBillArrV31) {
      Digit.Hooks.__ptFetchBillArrV31 = true;
      var origFetchBills = Digit.Hooks.useFetchBillsForBuissnessService;
      Digit.Hooks.useFetchBillsForBuissnessService = function () {
        var result = origFetchBills.apply(this, arguments);
        if (result) {
          result.data = result.data || {};
          if (!Array.isArray(result.data.Bill)) result.data.Bill = [];
          if (result.isError) {
            result.isError = false;
            result.error = null;
          }
        }
        return result;
      };
    }
    wrapPtSearchShape();
  }

  function wrapPtSearchShape() {
    if (!window.Digit || !Digit.Hooks) return;
    if (Digit.Hooks.pt && Digit.Hooks.pt.usePropertySearch && !Digit.Hooks.pt.__ptSearchShapeV43) {
      Digit.Hooks.pt.__ptSearchShapeV43 = true;
      var origShape = Digit.Hooks.pt.usePropertySearch;
      Digit.Hooks.pt.usePropertySearch = function (args, config) {
        args = rewritePtSearchArgs(args);
        var result;
        try {
          result = origShape.call(this, args, config);
        } catch (e) {
          result = { data: { Properties: [] }, isLoading: false, isError: false, error: null };
        }
        return hardenPtSearchResult(result, args);
      };
    }
    if (Digit.Hooks.useRecieptSearch && !Digit.Hooks.__ptReceiptV43) {
      Digit.Hooks.__ptReceiptV43 = true;
      var origRcpt = Digit.Hooks.useRecieptSearch;
      Digit.Hooks.useRecieptSearch = function () {
        var result = origRcpt.apply(this, arguments);
        if (!result) return { data: { Payments: [] }, isLoading: false, isError: false };
        result.data = result.data || {};
        if (!Array.isArray(result.data.Payments)) result.data.Payments = [];
        if (result.isError) {
          result.isError = false;
          result.error = null;
        }
        return result;
      };
    }
    // Shape hook disabled for PT — outer V59 hook owns nextActions (avoids wiping Take Action).
  }

  function seedPtNativeActions(data, moduleCode) {
    data = data && typeof data === "object" ? data : {};
    var bs = normalizePtBusinessService(moduleCode || data.businessService || "PT.CREATE");
    data = finalizePtWorkflow(data, bs, []);
    if (!Array.isArray(data.nextActions) || !data.nextActions.length) {
      var seeded = filterPtActionsByRole(
        normalizeNextActions(fallbackPtActionsForState("OPEN", bs))
      );
      data.nextActions = seeded;
      data.actionState = data.actionState || {};
      data.actionState.nextActions = seeded;
      data.initialActionState = data.initialActionState || data.actionState;
      data.initialActionState.nextActions = seeded;
      data.businessService = bs;
      data.applicationBusinessService = bs;
    }
    return coercePtWfRoles(data);
  }

  function fastPtNativeWorkflow(tid, id, moduleCode) {
    tid = hasCity(tid) ? tid : cityTenant();
    var a = authHeaders();
    var q = isPtAckId(id)
      ? "tenantId=" + encodeURIComponent(tid) + "&acknowledgementIds=" + encodeURIComponent(id)
      : "tenantId=" + encodeURIComponent(tid) + "&propertyIds=" + encodeURIComponent(id);
    return fetch("/property-services/property/_search?" + q, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        RequestInfo: { apiId: "Rainmaker", authToken: a.token, userInfo: a.info, msgId: "pt-native-v59" },
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var prop = (d && d.Properties && d.Properties[0]) || null;
        var bs = normalizePtBusinessService(moduleCode, prop);
        var status = prop ? String(prop.status || "").toUpperCase() : "";
        if (!prop) return seedPtNativeActions({}, moduleCode);
        if (status === "ACTIVE" || status === "INACTIVE" || status === "REJECTED" || status === "CANCELLED") {
          return finalizePtWorkflow(
            {
              timeline: [],
              nextActions: [],
              actionState: { nextActions: [] },
              processInstances: [],
              businessService: bs,
              applicationBusinessService: bs,
              __ptProperty: prop,
            },
            bs,
            []
          );
        }
        var ack = prop.acknowldgementNumber || prop.acknowledgementNumber || (isPtAckId(id) ? id : "");
        if (!ack) return seedPtNativeActions({ __ptProperty: prop }, bs);
        return fetch(
          "/egov-workflow-v2/egov-wf/process/_search?tenantId=" +
            encodeURIComponent(tid) +
            "&businessIds=" +
            encodeURIComponent(ack) +
            "&history=false",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              RequestInfo: { apiId: "Rainmaker", authToken: a.token, userInfo: a.info, msgId: "pt-native-wf59" },
            }),
          }
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (wf) {
            var pi = ((wf && wf.ProcessInstances) || [])[0] || {};
            var stateName = (pi.state && pi.state.state) || "OPEN";
            var src =
              (pi.nextActions && pi.nextActions.length && pi.nextActions) ||
              (pi.state && pi.state.actions) ||
              [];
            var acts = filterPtActionsByRole(normalizeNextActions(src));
            if (!acts.length) {
              acts = filterPtActionsByRole(
                normalizeNextActions(fallbackPtActionsForState(stateName, bs))
              );
            }
            return finalizePtWorkflow(
              {
                timeline: [
                  {
                    performedAction: pi.action || "OPEN",
                    action: pi.action || "OPEN",
                    status: (pi.state && (pi.state.applicationStatus || pi.state.state)) || stateName,
                    state: stateName,
                    timeLineActions: [],
                    thumbnailsToShow: { thumbs: null, images: [], fullImage: null },
                    assigner: pi.assigner || null,
                    assignes: pi.assignes || [],
                    caption: [],
                    comment: "",
                    wfComment: pi.comment ? [pi.comment] : [],
                    wfComments: [],
                    auditDetails: pi.auditDetails || {},
                  },
                ],
                nextActions: acts,
                actionState: Object.assign({}, pi.state || {}, { nextActions: acts }),
                processInstances: pi.businessId ? [pi] : [],
                businessService: pi.businessService || bs,
                applicationBusinessService: pi.businessService || bs,
                __ptProperty: prop,
              },
              bs,
              []
            );
          });
      })
      .catch(function () {
        return seedPtNativeActions({}, moduleCode);
      });
  }

  // City A only — never use state tenant "pg" for filestore/receipt URLs.
  function fileStorePublicUrl(_tenantId, id) {
    return (
      "/filestore/v1/files/id?tenantId=" +
      encodeURIComponent(cityTenant()) +
      "&fileStoreId=" +
      encodeURIComponent(id)
    );
  }

  function payRequestInfo() {
    var session = (window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || {};
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
        "/pdf-service/v1/_create?key=" + encodeURIComponent(keys[i]) + "&tenantId=" + encodeURIComponent(tenantId),
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
    tenantId = tenantId || cityTenant();
    return searchPtPayments(tenantId, consumerCode, receiptNo).then(function (payments) {
      if (!payments || !payments.length) {
        window.alert("No receipt found for this payment.");
        return { status: 404, data: null };
      }
      var existing = payments[0] && payments[0].fileStoreId;
      if (!existing && payments[0] && payments[0].paymentDetails && payments[0].paymentDetails[0]) {
        existing = payments[0].paymentDetails[0].fileStoreId;
      }
      var ready = existing ? Promise.resolve(existing) : createReceiptPdf(tenantId, payments);
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

  function hookReceiptDownload() {
    if (!window.Digit) return;
    if (Digit.Utils && !Digit.Utils.__receiptHookV25) {
      Digit.Utils.__receiptHookV25 = true;
      Digit.Utils.downloadReceipt = function (consumerCode, _bs, _key, tenantId, receiptNo) {
        return downloadPtReceipt(consumerCode, tenantId, receiptNo);
      };
    }
    if (Digit.ReceiptsService && !Digit.ReceiptsService.__receiptHookV25) {
      Digit.ReceiptsService.__receiptHookV25 = true;
      Digit.ReceiptsService.receipt_download = function (bs, consumerCode, tenantId, _key, receiptNo) {
        return downloadPtReceipt(consumerCode, tenantId, receiptNo);
      };
    }
    if (Digit.PaymentService && Digit.PaymentService.printReciept && !Digit.PaymentService.__printSafeV25) {
      Digit.PaymentService.__printSafeV25 = true;
      var origPrint = Digit.PaymentService.printReciept.bind(Digit.PaymentService);
      Digit.PaymentService.printReciept = function (tenantId, params) {
        var ids = (params && (params.fileStoreIds || params.fileStoreId)) || "";
        var id = String(ids).split(",")[0];
        var publicUrl = fileStorePublicUrl(cityTenant() || tenantId, id);
        return Promise.resolve(origPrint(cityTenant() || tenantId, params))
          .then(function (map) {
            if (id) {
              if (!map || typeof map !== "object") {
                map = {};
              }
              map[id] = publicUrl;
            }
            return map;
          })
          .catch(function () {
            var o = {};
            if (id) o[id] = publicUrl;
            return o;
          });
      };
    }
  }

  function mapBoundaryLocalities(tb, tid, hierarchy, tFn) {
    tid = hasCity(tid) ? tid : cityTenant();
    hierarchy = String(hierarchy || "REVENUE").toUpperCase();
    var boundary = (tb && tb.boundary) || [];
    if (!Array.isArray(boundary)) boundary = boundary ? [boundary] : [];
    var flat = [];
    function walk(nodes) {
      (nodes || []).forEach(function (n) {
        if (!n || typeof n !== "object") return;
        var label = String(n.label || n.boundaryType || "").toLowerCase();
        var kids = n.children;
        if (n.code && (label === "locality" || !kids || !kids.length)) {
          flat.push(n);
        }
        if (Array.isArray(kids) && kids.length) walk(kids);
      });
    }
    // Flat Locality search already returns leaf rows; nested tree needs a walk.
    if (
      boundary.length &&
      boundary[0] &&
      Array.isArray(boundary[0].children) &&
      boundary[0].children.length &&
      !boundary[0].label &&
      !boundary[0].boundaryType
    ) {
      walk(boundary);
    } else {
      flat = boundary.filter(function (n) {
        return n && n.code;
      });
    }
    var prefix = String(tid).replace(/\./g, "_").toUpperCase() + "_" + hierarchy;
    return flat.map(function (n) {
      var key = prefix + "_" + n.code;
      var display = n.name || n.code || key;
      try {
        if (typeof tFn === "function") {
          var tr = tFn(key);
          if (tr && String(tr) !== key) display = tr;
        }
      } catch (e) {}
      // Dropdown filters on t(option.i18nkey); keep a plain non-empty string.
      return Object.assign({}, n, {
        code: n.code,
        name: n.name || display,
        i18nkey: String(display),
      });
    });
  }

  function fetchBoundaryLocalities(tid, hierarchy) {
    tid = hasCity(tid) ? tid : cityTenant();
    var ht = String(hierarchy || "revenue").toLowerCase() === "admin" ? "ADMIN" : "REVENUE";
    var u = currentUser();
    var token = u.access_token || u.token || "";
    var info = u.info || u.UserRequest || null;
    return fetch(
      "/egov-location/location/v11/boundarys/_search?hierarchyTypeCode=" +
        ht +
        "&boundaryType=Locality&tenantId=" +
        encodeURIComponent(tid),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          RequestInfo: {
            apiId: "Rainmaker",
            authToken: token,
            userInfo: info,
            msgId: "boundary-loc-v47",
          },
        }),
      }
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var tb = (d && d.TenantBoundary && d.TenantBoundary[0]) || {};
        if (!tb.tenantId) tb.tenantId = tid;
        if (!tb.hierarchyType || !tb.hierarchyType.code) {
          tb.hierarchyType = Object.assign({}, tb.hierarchyType || {}, { code: ht });
        }
        return tb;
      });
  }

  function patchHooks() {
    if (!window.Digit || !Digit.Hooks) return false;

    // PT address form only copies localities into the dropdown when city state (U) is set.
    // That depends on Digit.Hooks.pt.useTenants() returning the current ULB. If PT_TENANTS
    // is empty/stale, City can still look filled while locality options never load.
    if (Digit.Hooks.pt && window.React && window.React.useState && !Digit.Hooks.pt.__tenantsSafeV48) {
      Digit.Hooks.pt.__tenantsSafeV48 = true;
      Digit.Hooks.pt.useTenants = function () {
        var React = window.React;
        var city = cityTenant();
        var build = function () {
          var list = [];
          try {
            list = Digit.SessionStorage.get("PT_TENANTS") || [];
          } catch (e) {}
          if (!Array.isArray(list) || !list.length) {
            try {
              var init = Digit.SessionStorage.get("initData");
              list = (init && init.tenants) || [];
            } catch (e2) {
              list = [];
            }
          }
          if (!Array.isArray(list)) list = [];
          var matched = list.filter(function (t) {
            return t && t.code === city;
          });
          if (!matched.length) {
            matched = [
              {
                code: city,
                name: "City A",
                i18nKey: "TENANT_TENANTS_PG_CITYA",
                pincode: [],
              },
            ];
          }
          return matched;
        };
        var st = React.useState(build);
        var tenants = st[0];
        var setTenants = st[1];
        React.useEffect(function () {
          setTenants(build());
        }, [city]);
        return tenants;
      };
    }

    // Replace locality hook only once React is available. An earlier v47 patch could bind
    // with React=undefined and permanently return [].
    if (
      Digit.Hooks.useBoundaryLocalities &&
      window.React &&
      window.React.useState &&
      window.React.useEffect &&
      !Digit.Hooks.__locSafeV48
    ) {
      Digit.Hooks.__locSafeV48 = true;
      var locCacheV48 = {};
      Digit.Hooks.useBoundaryLocalities = function (tenantId, hierarchy, config, tFn) {
        var React = window.React;
        var tid = hasCity(tenantId) ? tenantId : cityTenant();
        var hier = String(hierarchy || "revenue").toLowerCase();
        var enabled = !(config && config.enabled === false);
        try {
          if (String(window.location.pathname || "").indexOf("/pt/") !== -1) enabled = true;
        } catch (ePt) {}

        var cacheKey = tid + "|" + hier;
        var st = React.useState(function () {
          var hit = locCacheV48[cacheKey];
          if (hit && hit.data) return { data: hit.data, isLoading: false, isError: false };
          return { data: undefined, isLoading: !!enabled, isError: false };
        });
        var state = st[0];
        var setState = st[1];

        React.useEffect(
          function () {
            if (!enabled) {
              setState({ data: [], isLoading: false, isError: false });
              return;
            }
            if (locCacheV48[cacheKey] && locCacheV48[cacheKey].data) {
              setState({ data: locCacheV48[cacheKey].data, isLoading: false, isError: false });
              return;
            }
            var cancelled = false;
            setState(function (prev) {
              return Object.assign({}, prev, { isLoading: true });
            });
            fetchBoundaryLocalities(tid, hier)
              .then(function (tb) {
                if (cancelled) return;
                var mapped = mapBoundaryLocalities(
                  tb,
                  tid,
                  hier === "admin" ? "ADMIN" : "REVENUE",
                  tFn
                );
                locCacheV48[cacheKey] = { data: mapped };
                setState({ data: mapped, isLoading: false, isError: false });
              })
              .catch(function () {
                if (!cancelled) setState({ data: [], isLoading: false, isError: true });
              });
            return function () {
              cancelled = true;
            };
          },
          [tid, hier, enabled, cacheKey]
        );

        // Also sanitize any non-empty data so Dropdown filter (t(i18nkey)) never drops rows.
        var data = state.data;
        if (Array.isArray(data) && data.length) {
          data = data.map(function (n) {
            var label = (n && (n.name || n.code || n.i18nkey)) || "";
            return Object.assign({}, n, { i18nkey: String(label), name: (n && n.name) || String(label) });
          });
        }
        return {
          data: data,
          isLoading: state.isLoading,
          isError: state.isError,
          error: null,
          revalidate: function () {
            try {
              delete locCacheV48[cacheKey];
            } catch (e) {}
          },
        };
      };
    }

    // Ensure PTSelectAddress gets a city on formData so internal U state is set and
    // localities are copied into the Locality dropdown (option:N).
    try {
      var reg = Digit.ComponentRegistryService;
      if (reg && typeof reg.getComponent === "function" && !reg.__ptAddrCityV48) {
        reg.__ptAddrCityV48 = true;
        var origGetComp = reg.getComponent.bind(reg);
        reg.getComponent = function (name) {
          var Comp = origGetComp(name);
          if ((name !== "PTSelectAddress" && name !== "SelectAddress") || !Comp || !window.React) {
            return Comp;
          }
          return function PtAddressCityWrap(props) {
            var city = cityTenant();
            var cityObj = {
              code: city,
              name: "City A",
              i18nKey: "TENANT_TENANTS_PG_CITYA",
              pincode: [],
            };
            try {
              var tenants =
                (Digit.Hooks.pt && Digit.Hooks.pt.useTenants && Digit.Hooks.pt.useTenants()) || [];
              var hit = (tenants || []).filter(function (t) {
                return t && t.code === city;
              })[0];
              if (hit) cityObj = hit;
            } catch (eTen) {}
            var fd = Object.assign({}, props.formData || {});
            var addr = Object.assign({}, fd.address || {});
            if (!addr.city || !addr.city.code) addr.city = cityObj;
            fd.address = addr;
            return window.React.createElement(Comp, Object.assign({}, props, { formData: fd }));
          };
        };
      }
    } catch (eReg) {}

    if (Digit.Hooks.useFetchPayment && !Digit.Hooks.__ptFetchPayV24) {
      Digit.Hooks.__ptFetchPayV24 = true;
      var origFetchPay = Digit.Hooks.useFetchPayment;
      Digit.Hooks.useFetchPayment = function (params, config) {
        var p = Object.assign({}, params || {});
        p.tenantId = hasCity(p.tenantId) ? p.tenantId : cityTenant();
        if (p.consumerCode && String(p.consumerCode).indexOf("PG-PT-") === 0) p.tenantId = cityTenant();
        if (p.businessService && String(p.businessService).indexOf("PT") === 0) p.tenantId = cityTenant();
        config = Object.assign({ staleTime: 0, cacheTime: 0, refetchOnMount: "always" }, config || {});
        return origFetchPay(p, config);
      };
    }

    if (Digit.Hooks.useFetchCitizenBillsForBuissnessService && !Digit.Hooks.__ptCitizenBillsV22) {
      Digit.Hooks.__ptCitizenBillsV22 = true;
      var origCitizenBills = Digit.Hooks.useFetchCitizenBillsForBuissnessService;
      Digit.Hooks.useFetchCitizenBillsForBuissnessService = function (params, config) {
        var p = Object.assign({}, params || {});
        p.tenantId = hasCity(p.tenantId) ? p.tenantId : cityTenant();
        return origCitizenBills(p, config);
      };
    }

    if (Digit.Hooks.pgr && Digit.Hooks.pgr.useInboxData && !Digit.Hooks.pgr.__inboxPatchedV13) {
      Digit.Hooks.pgr.__inboxPatchedV13 = true;
      var origInbox = Digit.Hooks.pgr.useInboxData;
      Digit.Hooks.pgr.useInboxData = function (params) {
        var p = Object.assign({}, params || {}, { pgrFix: 13 });
        var result = origInbox(p);
        // v88: revalidate once per inbox entry + query params, not on every new result object (was an endless refetch loop)
        var v88Key = "";
        try { v88Key = JSON.stringify(p) + "|" + cityTenant() + "|" + ((window.history && window.history.state && window.history.state.key) || ""); } catch (eK) {}
        if (result && result.revalidate && !result.__pgrBusted && Digit.Hooks.pgr.__inboxBustKeyV88 !== v88Key) {
          result.__pgrBusted = true;
          Digit.Hooks.pgr.__inboxBustKeyV88 = v88Key;
          setTimeout(function () {
            try {
              result.revalidate();
            } catch (e) {}
          }, 50);
        }
        return result;
      };
    }

    if (Digit.Hooks.pgr && Digit.Hooks.pgr.useComplaintDetails && !Digit.Hooks.pgr.__complaintDetailsPatchedV10) {
      Digit.Hooks.pgr.__complaintDetailsPatchedV10 = true;
      var origDetailsHook = Digit.Hooks.pgr.useComplaintDetails;
      Digit.Hooks.pgr.useComplaintDetails = function (params) {
        var p = Object.assign({}, params || {});
        p.tenantId = hasCity(p.tenantId) ? p.tenantId : cityTenant();
        var result = origDetailsHook(p);
        if (result && result.error && !result.complaintDetails) {
          result.isError = false;
          result.error = null;
          result.complaintDetails = result.complaintDetails || {};
        }
        return result;
      };
    }

    if (Digit.Hooks.useWorkflowDetails && !Digit.Hooks.__pgrWfDetailsV71) {
      Digit.Hooks.__pgrWfDetailsV71 = true;
      var origWfHook = Digit.Hooks.useWorkflowDetails;
      var kicked = {};
      var kickedData = {};
      var ptWfSeed = {};
      // v89: per-id visit key + in-flight flag so the cached PGR workflow is re-fetched once per complaint-page visit / explicit revalidate
      var kickVisit = {};
      var kickBusy = {};
      function v89VisitKey() {
        try {
          var path = String((window.location && window.location.pathname) || "");
          if (!/^\/digit-ui\/(citizen\/pgr\/complaints|employee\/pgr\/complaint\/details)\/[^\/]+/.test(path)) return "";
          return path + "|" + ((window.history && window.history.state && window.history.state.key) || "");
        } catch (e) { return ""; }
      }
      Digit.Hooks.useWorkflowDetails = function (params) {
        var p = Object.assign({}, params || {});
        p.tenantId = hasCity(p.tenantId) ? p.tenantId : cityTenant();
        var result = origWfHook(p);
        if (!result) result = { data: {}, isLoading: false, isError: false };
        var isPgr =
          p.moduleCode === "PGR" ||
          (typeof window !== "undefined" && window.location && String(window.location.href).indexOf("/pgr/") !== -1);
        var isPt = isPtPath(p.moduleCode);
        if (isPgr && result && p.id) {
          // v89: on PGR complaint pages only, a new visit or an explicit revalidate re-fetches (old kickedData stays until the new one arrives)
          var v89Rv = result.revalidate, v89Visit = v89VisitKey();
          if (v89Visit && kicked[p.id] && !kickBusy[p.id] && kickVisit[p.id] !== v89Visit) kicked[p.id] = false;
          if (!kicked[p.id]) {
            kicked[p.id] = true;
            kickVisit[p.id] = v89Visit;
            kickBusy[p.id] = true;
            pgrWorkflowDetails(p.tenantId, p.id).then(function (data) {
              kickBusy[p.id] = false;
              kickedData[p.id] = data;
              try {
                if (v89Rv) v89Rv(); // v89: the ORIGINAL revalidate (never the wrapper below) = no refetch loop
              } catch (e) {}
            }, function () { kickBusy[p.id] = false; });
          }
          if (v89Visit && v89Rv) {
            result.revalidate = function () {
              if (!kickBusy[p.id]) kicked[p.id] = false; // re-kick on the next render
              return v89Rv.apply(this, arguments);
            };
          }
          if (kickedData[p.id]) {
            result.data = kickedData[p.id];
            result.isLoading = false;
            result.isError = false;
            result.error = null;
          } else if (result.data) {
            ensureSafeWorkflowDetails(result.data, p.id);
            result.isError = false;
            result.error = null;
          }
        }
        if (isPt && result && p.id) {
          var ptKey = "pt-" + p.id;
          if (!ptWfKicked[ptKey]) {
            ptWfKicked[ptKey] = true;
            // Fast native path: property + process by ack (avoid hanging BS lookups)
            fastPtNativeWorkflow(p.tenantId, p.id, p.moduleCode).then(function (data) {
              // Coerce once and keep a stable reference — re-coercing every render froze the page.
              ptWfData[ptKey] = coercePtWfRoles(data);
              try {
                if (result.revalidate) result.revalidate();
              } catch (e) {}
            });
          }
          if (ptWfData[ptKey]) {
            result.data = ptWfData[ptKey];
          } else {
            if (!ptWfSeed[ptKey]) {
              ptWfSeed[ptKey] = coercePtWfRoles(seedPtNativeActions({}, p.moduleCode));
            }
            result.data = ptWfSeed[ptKey];
          }
          // Digit hides WF_TAKE_ACTION while isLoading === true
          result.isLoading = false;
          result.isError = false;
          result.error = null;
        }
        return result;
      };
    }

    if (Digit.Hooks.pgr && !Digit.Hooks.pgr.useMDMS) {
      Digit.Hooks.pgr.useMDMS = {};
    }
    if (Digit.Hooks.pgr && Digit.Hooks.pgr.useMDMS && !Digit.Hooks.pgr.useMDMS.ComplainClosingTime) {
      Digit.Hooks.pgr.useMDMS.ComplainClosingTime = function () {
        return { data: 0, isLoading: false, isError: false };
      };
    }

    return !!(Digit.Hooks.pgr && Digit.Hooks.pgr.useComplaintDetails && Digit.Hooks.useWorkflowDetails);
  }

  function sanitizeHtmlPattern(p) {
    if (typeof p !== "string") return p;
    // JS-style "/^[a-zA-Z0-9-]*$/" or broken "/^[a-zA-Z0-9-]*$" → HTML pattern
    var m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return m[1];
    if (p.charAt(0) === "/" && p.indexOf("^") === 1) {
      var inner = p.slice(1);
      if (inner.charAt(inner.length - 1) === "/") inner = inner.slice(0, -1);
      return inner;
    }
    return p;
  }

  function normalizeOwnershipCategoryUpdate(oc, owners) {
    var code = "";
    if (typeof oc === "string") code = oc;
    else if (oc && typeof oc === "object") code = oc.code || oc.value || "";
    code = String(code || "");
    if (!code) code = "INDIVIDUAL.SINGLEOWNER";
    if (code === "INDIVIDUAL") {
      var n = Array.isArray(owners) ? owners.filter(Boolean).length : 1;
      code = n > 1 ? "INDIVIDUAL.MULTIPLEOWNERS" : "INDIVIDUAL.SINGLEOWNER";
    }
    return { code: code, value: code, i18nKey: "PT_OWNERSHIP_" + (code.split(".")[1] || code) };
  }

  function sanitizePtCheckFormValue(value) {
    var v = Object.assign({}, value || {});
    v.units = Array.isArray(v.units) && v.units.length ? v.units : [{}];
    v.ownershipCategory = normalizeOwnershipCategoryUpdate(v.ownershipCategory, v.owners);
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
      if (docs && typeof docs === "object" && !Array.isArray(docs)) {
        proof = docs.proofIdentity || null;
      } else if (Array.isArray(docs)) {
        docs.forEach(function (d) {
          if (!d) return;
          var dt = typeof d.documentType === "string" ? d.documentType : (d.documentType && d.documentType.code) || "";
          if (String(dt).indexOf("IDENTITYPROOF") !== -1) proof = d;
        });
      }
      if (!proof) proof = { name: "na", fileStoreId: "NA", documentType: "OWNER.IDENTITYPROOF.AADHAAR" };
      if (!proof.name) proof.name = proof.fileStoreId || "na";
      o.documents = { proofIdentity: proof };
      return o;
    });
    return v;
  }

  function wrapMutateComponents() {
    var reg = window.Digit && Digit.ComponentRegistryService;
    var React = window.React;
    if (!reg || typeof reg.getComponent !== "function" || reg.__ptMutateGetV64) return;
    if (!React) return;
    reg.__ptMutateGetV64 = true;
    var origGet = reg.getComponent.bind(reg);
    var wrapped = {};
    reg.getComponent = function (name) {
      var C = origGet(name);
      if (!C) return C;

      if (name === "PTCheckPage" || name === "CheckPage") {
        if (wrapped[name]) return wrapped[name];
        wrapped[name] = function PTCheckPageSafe(props) {
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
              "Could not render update summary. Go Back and retry."
            );
          }
        };
        return wrapped[name];
      }

      if (name === "SelectOwnerShipDetails") {
        if (wrapped[name]) return wrapped[name];
        wrapped[name] = function SelectOwnerShipDetailsUpdateSafe(props) {
          var next = Object.assign({}, props || {});
          var path = "";
          try {
            path = (window.location && window.location.pathname) || "";
          } catch (e) {}
          if (path.indexOf("/edit-application/") !== -1 || path.indexOf("/modify-application/") !== -1) {
            var fd = Object.assign({}, next.formData || {});
            var norm = normalizeOwnershipCategoryUpdate(fd.ownershipCategory, fd.owners);
            fd.ownershipCategory = norm;
            try {
              sessionStorage.setItem("ownershipCategory", norm.value);
            } catch (e2) {}
            next.formData = fd;
          }
          return React.createElement(C, next);
        };
        return wrapped[name];
      }

      if (name !== "TransfererDetails") {
        return C;
      }
      if (wrapped[name]) return wrapped[name];
      function Safe(props) {
        var next = Object.assign({}, props || {});
        var path = "";
        try {
          path = (window.location && window.location.pathname) || "";
        } catch (e) {}
        if (path.indexOf("/employee/") !== -1) next.userType = next.userType || "employee";
        var fd = Object.assign({}, next.formData || {});
        var orig = fd.originalData || (fd.searchResult && fd.searchResult.property) || {};
        if (!orig || typeof orig !== "object") orig = {};
        orig = Object.assign({}, orig);
        if (!Array.isArray(orig.owners) || !orig.owners.length) orig.owners = [dummyPtOwner()];
        orig.owners = orig.owners.filter(Boolean).map(function (o) {
          o = Object.assign({}, o);
          if (!o.ownerType) o.ownerType = "NONE";
          if (!Array.isArray(o.documents) || !o.documents[0]) {
            o.documents = [{ documentType: "NA", documentUid: "NA", fileStoreId: "NA" }];
          }
          return o;
        });
        orig.ownershipCategory = orig.ownershipCategory || "INDIVIDUAL.SINGLEOWNER";
        fd.originalData = orig;
        if (!fd.searchResult || !fd.searchResult.property) fd.searchResult = { property: orig };
        next.formData = fd;
        try {
          return C(next);
        } catch (err) {
          return null;
        }
      }
      wrapped[name] = Safe;
      return Safe;
    };
  }

  // P0: Employee New Property UID — strip JS regex delimiters from HTML pattern and
  // accept alphanumeric UIDs (stock employee check is digits-only → permanent Invalid input).
  function wrapUidValidation() {
    var reg = window.Digit && Digit.ComponentRegistryService;
    if (!reg || typeof reg.getComponent !== "function" || reg.__ptUidFixV52) return;
    if (!window.React) return;
    reg.__ptUidFixV52 = true;
    var origGet = reg.getComponent.bind(reg);
    var uidWrap = null;
    var textWrap = null;

    function EmployeeUidField(props) {
      var React = window.React;
      var t = props.t || function (k) {
        return k;
      };
      var config = props.config || {};
      var key = config.key || "uid";
      var formData = props.formData || {};
      var onSelect = props.onSelect;
      var initial = formData[key];
      if (initial && typeof initial === "object") initial = initial.value || initial[key] || "";
      var state = React.useState(initial == null ? "" : String(initial));
      var val = state[0];
      var setVal = state[1];
      var setError = props.setError;
      var clearErrors = props.clearErrors || props.clearError;

      React.useEffect(
        function () {
          var ok =
            val === undefined ||
            val === "" ||
            (/^[a-zA-Z0-9-]{0,15}$/.test(val) && val.length === 15);
          try {
            if (ok) {
              if (typeof clearErrors === "function") clearErrors(key);
            } else if (typeof setError === "function") {
              setError(key, { type: "invalid", message: t("ERR_DEFAULT_INPUT_FIELD_MSG") });
            }
          } catch (eErr) {}
        },
        [val, key]
      );

      function onChange(e) {
        var n = e && e.target ? e.target.value : e;
        n = String(n == null ? "" : n).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 15);
        setVal(n);
        try {
          if (typeof onSelect === "function") onSelect(key, n);
        } catch (eSel) {}
      }

      var TextInput = origGet("TextInput") || origGet("TextField") || "input";
      var CardLabel = origGet("CardLabel") || "label";
      var LabelFieldPair = origGet("LabelFieldPair") || "div";
      var label = config.label || config.texts || "PT_ELECTRICITY_UID";
      if (typeof label === "object") label = label.label || "PT_ELECTRICITY_UID";

      return React.createElement(
        LabelFieldPair,
        { className: "uid-fix-v52" },
        React.createElement(CardLabel, { className: "uid-label" }, t(String(label))),
        React.createElement(TextInput, {
          key: key,
          id: key,
          name: key,
          value: val,
          onChange: onChange,
          maxLength: 15,
          pattern: "^[a-zA-Z0-9-]*$",
          title: t("ERR_DEFAULT_INPUT_FIELD_MSG"),
          type: "text",
        })
      );
    }

    reg.getComponent = function (name) {
      var C = origGet(name);
      if (!C) return C;

      if (name === "TextInput" || name === "TextField") {
        if (textWrap) return textWrap;
        textWrap = function TextInputPatternFix(props) {
          var next = Object.assign({}, props || {});
          if (typeof next.pattern === "string") {
            next.pattern = sanitizeHtmlPattern(next.pattern);
          }
          if (next.validation && typeof next.validation === "object" && typeof next.validation.pattern === "string") {
            next.validation = Object.assign({}, next.validation, {
              pattern: sanitizeHtmlPattern(next.validation.pattern),
            });
          }
          return window.React.createElement(C, next);
        };
        return textWrap;
      }

      if (name !== "UID") return C;
      if (uidWrap) return uidWrap;
      uidWrap = function FixedUID(props) {
        var userType = props && props.userType;
        try {
          if (!userType && String(window.location.pathname || "").indexOf("/employee/") !== -1) {
            userType = "employee";
          }
        } catch (ePath) {}
        if (userType === "employee") {
          return window.React.createElement(EmployeeUidField, props);
        }
        var next = Object.assign({}, props || {});
        if (next.config && next.config.validation && typeof next.config.validation.pattern === "string") {
          next.config = Object.assign({}, next.config, {
            validation: Object.assign({}, next.config.validation, {
              pattern: sanitizeHtmlPattern(next.config.validation.pattern),
            }),
          });
        }
        return window.React.createElement(C, next);
      };
      return uidWrap;
    };
  }

  function guardPtErrorRedirect() {
    if (window.__ptErrGuardV43) return;
    window.__ptErrGuardV43 = true;
    function onPt() {
      try {
        return String(window.location.pathname || "").indexOf("/pt/") !== -1;
      } catch (e) {
        return false;
      }
    }
    function isErrUrl(url) {
      return String(url || "").indexOf("/user/error") !== -1;
    }
    function remember(msg) {
      try {
        sessionStorage.setItem("PT_LAST_CRASH", String(msg || "").slice(0, 4000));
      } catch (e) {}
    }
    var origPush = window.history.pushState.bind(window.history);
    var origReplace = window.history.replaceState.bind(window.history);
    window.history.pushState = function (state, title, url) {
      if (onPt() && isErrUrl(url)) {
        remember("blocked /user/error redirect");
        return;
      }
      return origPush(state, title, url);
    };
    window.history.replaceState = function (state, title, url) {
      if (onPt() && isErrUrl(url)) {
        remember("blocked /user/error replace");
        return;
      }
      return origReplace(state, title, url);
    };
    try {
      ["assign", "replace"].forEach(function (fn) {
        var origNav = Location.prototype[fn];
        if (typeof origNav !== "function") return;
        Location.prototype[fn] = function (url) {
          if (onPt() && isErrUrl(url)) {
            remember("blocked location." + fn);
            return;
          }
          return origNav.call(this, url);
        };
      });
    } catch (eAssign) {}
    try {
      var hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, "href") || Object.getOwnPropertyDescriptor(window.location, "href");
      if (hrefDesc && hrefDesc.set && !Location.prototype.__ptHrefGuardV43) {
        Location.prototype.__ptHrefGuardV43 = true;
        Object.defineProperty(Location.prototype, "href", {
          configurable: true,
          enumerable: true,
          get: function () {
            return hrefDesc.get.call(this);
          },
          set: function (v) {
            if (onPt() && isErrUrl(v)) {
              remember("blocked location.href to error");
              return v;
            }
            return hrefDesc.set.call(this, v);
          },
        });
      }
    } catch (eHref) {}
    try {
      if (window.navigation && typeof window.navigation.addEventListener === "function" && !window.__ptNavGuardV43) {
        window.__ptNavGuardV43 = true;
        window.navigation.addEventListener("navigate", function (ev) {
          try {
            var dest = ev && ev.destination && ev.destination.url;
            if (!isErrUrl(dest)) return;
            if (!onPt()) return;
            remember("blocked navigation to /user/error");
            if (ev.cancelable && typeof ev.preventDefault === "function") ev.preventDefault();
          } catch (eNav) {}
        });
      }
    } catch (eNavApi) {}
    window.addEventListener("error", function (ev) {
      if (!onPt()) return;
      var err = ev && ev.error;
      remember((err && (err.stack || err.message)) || (ev && ev.message) || "error");
    });
    window.addEventListener("unhandledrejection", function (ev) {
      if (!onPt()) return;
      var r = ev && ev.reason;
      remember((r && (r.stack || r.message)) || String(r || "rejection"));
    });
  }

  function patch() {
    guardPtErrorRedirect();
    var servicesReady = patchServices();
    var hooksReady = patchHooks();
    patchPtUi();
    stubPtTrackApis();
    wrapPtAssessmentHooks();
    wrapPtSearchShape();
    wrapMutateComponents();
    wrapUidValidation();
    hookReceiptDownload();
    if (!servicesReady || !hooksReady) {
      setTimeout(patch, 250);
    }
  }

  patch();

  var ptWrapTries = 0;
  var ptWrapTimer = setInterval(function () {
    guardPtErrorRedirect();
    patchPtUi();
    wrapMutateComponents();
    wrapUidValidation();
    wrapPtAssessmentHooks();
    wrapPtSearchShape();
    ptWrapTries += 1;
    if (
      (window.React &&
        window.React.__ptUiPatchedV40 &&
        window.Digit &&
        Digit.PTService &&
        Digit.PTService.__ptCalcSvcV29 &&
        Digit.ComponentRegistryService &&
        Digit.ComponentRegistryService.__ptUidFixV52) ||
      ptWrapTries > 80
    ) {
      clearInterval(ptWrapTimer);
    }
  }, 250);

  // Citizen profile locks email/DOB. Overlay real inputs and POST /user/profile/_update
  // with RequestInfo.userInfo (Digit.UserService.updateUser omits userService, so userInfo
  // is missing and egov-user rejects the save).
  var EMAIL_OK = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;

  function onCitizenProfile() {
    var path = (window.location && window.location.pathname) || "";
    return path.indexOf("/citizen/user/profile") !== -1;
  }

  function showProfileMsg(ok, text) {
    var box = document.getElementById("upyog-email-overlay");
    var parent = box && box.parentNode;
    if (!parent) return;
    var el = document.getElementById("upyog-email-msg");
    if (!el) {
      el = document.createElement("div");
      el.id = "upyog-email-msg";
      parent.appendChild(el);
    }
    el.textContent = text;
    el.style.color = ok ? "#00703c" : "#a82227";
    el.style.marginTop = "8px";
    el.style.fontSize = "14px";
    el.style.fontWeight = "600";
  }

  function numericId(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
    return null;
  }

  function toDateInputValue(raw) {
    if (!raw) return "";
    var s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
    if (m) {
      var dd = ("0" + m[1]).slice(-2);
      var mm = ("0" + m[2]).slice(-2);
      return m[3] + "-" + mm + "-" + dd;
    }
    var n = Number(s);
    var d = n > 100000 ? new Date(n) : new Date(s);
    if (!isNaN(d.getTime())) {
      var yyyy = d.getFullYear();
      var mo = ("0" + (d.getMonth() + 1)).slice(-2);
      var da = ("0" + d.getDate()).slice(-2);
      return yyyy + "-" + mo + "-" + da;
    }
    return "";
  }

  function toApiDob(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return null;
    return m[3] + "/" + m[2] + "/" + m[1];
  }

  function genderCode(v) {
    if (!v) return null;
    var s = typeof v === "object" ? v.code || v.value || v.name : v;
    if (!s) return null;
    s = String(s).trim();
    if (/^female$/i.test(s)) return "FEMALE";
    if (/^male$/i.test(s)) return "MALE";
    if (/^trans/i.test(s) || /^other/i.test(s)) return "TRANSGENDER";
    return s.toUpperCase();
  }

  function fixDobLabel() {
    var nodes = document.querySelectorAll(".card-label, label");
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || "").trim();
      if (t.indexOf("CORE_COMMON_PROFILE_DOB") === 0) nodes[i].textContent = "Date of Birth*";
    }
  }

  function ensureProfileOverlays() {
    try {
      if (!onCitizenProfile()) {
        ["upyog-email-overlay", "upyog-dob-overlay", "upyog-email-msg"].forEach(function (id) {
          var n = document.getElementById(id);
          if (n && n.parentNode) n.parentNode.removeChild(n);
        });
        return;
      }
      fixDobLabel();
      var origEmail = document.querySelector('input[name="email"]');
      if (origEmail) {
        origEmail.setAttribute("tabindex", "-1");
        origEmail.style.display = "none";
        var emailOv = document.getElementById("upyog-email-overlay");
        if (emailOv && emailOv.parentNode !== origEmail.parentNode) {
          emailOv.parentNode.removeChild(emailOv);
          emailOv = null;
        }
        if (!emailOv) {
          emailOv = document.createElement("input");
          emailOv.id = "upyog-email-overlay";
          emailOv.type = "text";
          emailOv.autocomplete = "email";
          emailOv.placeholder = "Enter a valid Email";
          emailOv.value = window.__upyogEmailDraft || (origEmail.value || "").trim();
          emailOv.className = "citizen-card-input focus-visible";
          emailOv.style.cssText =
            "width:100%;height:40px;padding:0 8px;border:1px solid #0b0c0c;background:#ffffff;pointer-events:auto;cursor:text;font-size:16px;box-sizing:border-box;";
          origEmail.parentNode.insertBefore(emailOv, origEmail);
          emailOv.addEventListener("input", function () {
            window.__upyogEmailDraft = emailOv.value;
          });
        }
      }
      var origDob = document.querySelector('input[type="date"]:not(#upyog-dob-overlay)');
      var dobOv = document.getElementById("upyog-dob-overlay");
      if (origDob) {
        origDob.setAttribute("tabindex", "-1");
        origDob.style.display = "none";
        origDob.disabled = true;
        if (dobOv && dobOv.parentNode !== origDob.parentNode) {
          origDob.parentNode.insertBefore(dobOv, origDob);
        }
        if (!dobOv) {
          dobOv = document.createElement("input");
          dobOv.id = "upyog-dob-overlay";
          dobOv.type = "date";
          dobOv.max = new Date().toISOString().slice(0, 10);
          dobOv.value = window.__upyogDobDraft || toDateInputValue(origDob.value);
          dobOv.className = "citizen-card-input focus-visible";
          origDob.parentNode.insertBefore(dobOv, origDob);
          dobOv.addEventListener("input", function () {
            window.__upyogDobDraft = dobOv.value;
          });
          dobOv.addEventListener("change", function () {
            window.__upyogDobDraft = dobOv.value;
          });
        }
      } else if (!dobOv) {
        var labels = document.querySelectorAll(".card-label, label");
        var host = null;
        for (var li = 0; li < labels.length; li++) {
          var lt = (labels[li].textContent || "").trim();
          if (lt.indexOf("Date of Birth") === 0 || lt.indexOf("CORE_COMMON_PROFILE_DOB") === 0) {
            host = labels[li].parentNode;
            break;
          }
        }
        if (host) {
          dobOv = document.createElement("input");
          dobOv.id = "upyog-dob-overlay";
          dobOv.type = "date";
          dobOv.max = new Date().toISOString().slice(0, 10);
          dobOv.value = window.__upyogDobDraft || "";
          dobOv.className = "citizen-card-input focus-visible";
          host.appendChild(dobOv);
          dobOv.addEventListener("input", function () {
            window.__upyogDobDraft = dobOv.value;
          });
          dobOv.addEventListener("change", function () {
            window.__upyogDobDraft = dobOv.value;
          });
        }
      }
      if (dobOv) {
        dobOv.disabled = false;
        dobOv.readOnly = false;
        dobOv.style.cssText =
          "width:100%;height:40px;padding:0 8px;border:1px solid #0b0c0c;background:#ffffff;pointer-events:auto;cursor:pointer;font-size:16px;box-sizing:border-box;display:block;visibility:visible;opacity:1;";
      }
    } catch (e) {}
  }

  function sessionUser() {
    var session = (window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || {};
    var info = session.info || session.UserRequest || {};
    return { session: session, info: info };
  }

  function findFullUser(info) {
    var tenant = info.tenantId || "pg";
    if (Digit.UserService.userSearch && info.uuid) {
      return Digit.UserService.userSearch(tenant, { uuid: [info.uuid] }, {}).then(function (res) {
        var list = (res && (res.user || res.users)) || [];
        return list[0] || info;
      }).catch(function () {
        return info;
      });
    }
    return Promise.resolve(info);
  }

  function saveCitizenProfile(e) {
    if (!onCitizenProfile()) return;
    var btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;
    var label = (btn.textContent || "").replace(/\s+/g, " ").trim();
    if (label !== "Save" && label.indexOf("CORE_COMMON_SAVE") === -1 && label !== "SAVE") return;
    var emailOv = document.getElementById("upyog-email-overlay");
    var dobOv = document.getElementById("upyog-dob-overlay");
    if (!emailOv && !dobOv) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var email = emailOv ? (emailOv.value || "").trim() : "";
    var dobIso = dobOv ? (dobOv.value || "").trim() : "";
    if (email && !EMAIL_OK.test(email)) {
      showProfileMsg(false, "Enter a valid email (for example name@gmail.com)");
      emailOv.focus();
      return;
    }
    if (dobIso) {
      var born = new Date(dobIso + "T00:00:00");
      var min = new Date();
      min.setFullYear(min.getFullYear() - 18);
      if (isNaN(born.getTime()) || born > min) {
        showProfileMsg(false, "Date of birth must be 18 years or older");
        dobOv.focus();
        return;
      }
    }
    try {
      if (!window.Digit || !Digit.UserService) {
        showProfileMsg(false, "Please wait for the page to finish loading, then Save again.");
        return;
      }
      var ctx = sessionUser();
      var session = ctx.session;
      var info = ctx.info;
      var token = session.access_token;
      if (!token) {
        showProfileMsg(false, "Please log in again, then Save.");
        return;
      }
      btn.disabled = true;
      findFullUser(info).then(function (full) {
        var id = numericId(full.id) || numericId(info.id);
        var uuid = full.uuid || info.uuid;
        if (!id || !uuid) {
          btn.disabled = false;
          showProfileMsg(false, "Could not load your user id. Please log in again.");
          return;
        }
        var nameEl = document.querySelector('input[name="name"]');
        var name = (nameEl && nameEl.value) || full.name || info.name;
        var gender = genderCode(full.gender) || genderCode(info.gender) || "FEMALE";
        var tenant = full.tenantId || info.tenantId || "pg";
        var userInfo = {
          id: id,
          uuid: uuid,
          userName: full.userName || info.userName,
          name: name,
          mobileNumber: full.mobileNumber || info.mobileNumber,
          emailId: email || full.emailId || info.emailId || null,
          type: full.type || info.type || "CITIZEN",
          tenantId: tenant,
          roles: full.roles || info.roles || [{ code: "CITIZEN", name: "Citizen", tenantId: tenant }],
        };
        var payloadUser = {
          id: id,
          uuid: uuid,
          userName: userInfo.userName,
          name: name,
          gender: gender,
          mobileNumber: userInfo.mobileNumber,
          emailId: email || null,
          altContactNumber: full.altContactNumber || info.altContactNumber || null,
          type: userInfo.type,
          active: true,
          tenantId: tenant,
          locale: (Digit.StoreData && Digit.StoreData.getCurrentLanguage && Digit.StoreData.getCurrentLanguage()) || "en_IN",
        };
        var apiDob = toApiDob(dobIso);
        if (apiDob) payloadUser.dob = apiDob;
        var body = {
          RequestInfo: {
            apiId: "Rainmaker",
            ver: ".01",
            ts: Date.now(),
            action: "update",
            did: "1",
            key: "",
            msgId: Date.now() + "|en_IN",
            authToken: token,
            userInfo: userInfo,
          },
          user: payloadUser,
        };
        body.requestInfo = body.RequestInfo;
        return fetch("/user/profile/_update?tenantId=" + encodeURIComponent(tenant), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().then(function (j) {
            return { http: r.status, json: j };
          }).catch(function () {
            return { http: r.status, json: null };
          });
        });
      }).then(function (out) {
        btn.disabled = false;
        if (!out) return;
        var res = out.json || {};
        var status = res.responseInfo && res.responseInfo.status;
        var ok = out.http === 200 || String(status) === "200" || !!(res.user || res.users);
        if (ok) {
          var nextInfo = {};
          for (var ik in info) {
            if (Object.prototype.hasOwnProperty.call(info, ik)) nextInfo[ik] = info[ik];
          }
          var savedName = (document.querySelector('input[name="name"]') || {}).value;
          if (savedName) nextInfo.name = savedName;
          if (email) nextInfo.emailId = email;
          var next = {};
          for (var sk in session) {
            if (Object.prototype.hasOwnProperty.call(session, sk)) next[sk] = session[sk];
          }
          next.info = nextInfo;
          Digit.UserService.setUser(next);
          showProfileMsg(true, "Profile saved");
          return;
        }
        var err = (res.Errors && res.Errors[0]) || {};
        showProfileMsg(false, err.message || err.code || "Could not save profile. Try again.");
      }).catch(function () {
        btn.disabled = false;
        showProfileMsg(false, "Could not save profile. Try again.");
      });
    } catch (err) {
      showProfileMsg(false, "Could not save profile. Try again.");
    }
  }

  function watchProfileFields() {
    ensureProfileOverlays();
    if (window.__upyogProfileEmailWatch) return;
    window.__upyogProfileEmailWatch = true;
    setInterval(ensureProfileOverlays, 300);
    document.addEventListener("click", saveCitizenProfile, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchProfileFields);
  } else {
    watchProfileFields();
  }

  function patchPaymentGateway(obj) {
    try {
      var ui = obj && obj.MdmsRes && obj.MdmsRes["DIGIT-UI"];
      if (ui && Array.isArray(ui.PaymentGateway)) {
        ui.PaymentGateway = [{ gateway: "RAZORPAY", active: true }];
      }
    } catch (e) {}
    return obj;
  }

  function buildPayRequestInfo() {
    var session = (window.Digit && Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || {};
    return {
      apiId: "Rainmaker",
      ver: ".01",
      ts: "",
      action: "_create",
      did: "1",
      key: "",
      msgId: Date.now() + "|en_IN",
      authToken: session.access_token,
      userInfo: session.info,
    };
  }

  function loadRazorpayCheckout(cb) {
    if (window.Razorpay) return cb();
    var s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = function () {
      cb();
    };
    s.onerror = function () {
      cb(new Error("checkout_load_failed"));
    };
    document.head.appendChild(s);
  }

  function startRazorpay(_tenantId, data) {
    var txn = (data && data.Transaction) || data || {};
    var payload = {
      RequestInfo: (data && (data.RequestInfo || data.requestInfo)) || buildPayRequestInfo(),
      Transaction: txn,
    };
    return fetch("/digit-ui/razorpay/order", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { http: r.status, json: j };
        });
      })
      .then(function (out) {
        if (!out || out.http >= 300 || !out.json || !out.json.order_id) {
          var err = new Error("RAZORPAY_ORDER_FAILED");
          err.response = { data: { Errors: [{ message: "Could not start Razorpay. Try again." }] } };
          throw err;
        }
        var order = out.json;
        return new Promise(function (resolve, reject) {
          loadRazorpayCheckout(function (loadErr) {
            if (loadErr || !window.Razorpay) {
              reject(loadErr || new Error("checkout_unavailable"));
              return;
            }
            var rzp = new window.Razorpay({
              key: order.key,
              amount: order.amount,
              currency: order.currency || "INR",
              name: order.name || "eNagariseva",
              description: order.description || "Payment",
              order_id: order.order_id,
              prefill: order.prefill || {},
              theme: { color: "#c84c0e" },
              handler: function (resp) {
                fetch("/digit-ui/razorpay/verify", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    RequestInfo: payload.RequestInfo,
                    Transaction: txn,
                    razorpay_order_id: resp.razorpay_order_id,
                    razorpay_payment_id: resp.razorpay_payment_id,
                    razorpay_signature: resp.razorpay_signature,
                  }),
                })
                  .then(function (r) {
                    return r.json().then(function (j) {
                      return { http: r.status, json: j };
                    });
                  })
                  .then(function (v) {
                    if (!v || v.http >= 300 || !v.json || !v.json.ok) {
                      var verr = new Error("RAZORPAY_VERIFY_FAILED");
                      verr.response = { data: { Errors: [{ message: "Payment succeeded at Razorpay but receipt failed. Contact the ULB." }] } };
                      reject(verr);
                      return;
                    }
                    var paidCode = txn.consumerCode || "";
                    window.location =
                      "/digit-ui/citizen/pt/property/property-information/" +
                      encodeURIComponent(paidCode) +
                      "?payment=success";
                  })
                  .catch(reject);
              },
              modal: {
                ondismiss: function () {
                  var e = new Error("Payment cancelled");
                  e.response = { data: { Errors: [{ message: "Payment cancelled" }] } };
                  reject(e);
                },
              },
            });
            rzp.open();
          });
        });
      });
  }

  function stubObpsPaymentHooks() {
    if (!window.Digit || !Digit.Hooks) return;
    if (!Digit.Hooks.obps) Digit.Hooks.obps = {};
    if (typeof Digit.Hooks.obps.useOBPSSearch !== "function") {
      Digit.Hooks.obps.useOBPSSearch = function () {
        return { data: {}, isLoading: false, isError: false };
      };
    }
  }

  function hookPaymentService() {
    wrapPtBillService();
    stubObpsPaymentHooks();
    var ps = window.Digit && Digit.PaymentService;
    if (ps && typeof ps.createReciept === "function" && !ps.__receiptNumSafeV30) {
      ps.__receiptNumSafeV30 = true;
      var origCreate = ps.createReciept.bind(ps);
      ps.createReciept = function (tenantId, data) {
        return Promise.resolve(origCreate(tenantId, data)).then(function (res) {
          try {
            var pmt = res && res.Payments && res.Payments[0];
            var pd = pmt && pmt.paymentDetails && pmt.paymentDetails[0];
            if (pd && (pd.receiptNumber == null || pd.receiptNumber === "")) {
              pd.receiptNumber = String(pd.id || pmt.transactionNumber || "PT-RECEIPT");
            }
          } catch (e) {}
          return res;
        });
      };
    }
    if (!ps || ps.__rzpHooked) return;
    if (typeof ps.createCitizenReciept !== "function") return;
    ps.createCitizenReciept = function (tenantId, data) {
      return startRazorpay(tenantId, data);
    };
    ps.__rzpHooked = true;
  }

  if (!window.__upyogRzpFetch && window.fetch) {
    window.__upyogRzpFetch = true;
    var origFetch = window.fetch;
    window.fetch = function () {
      var url = "";
      try {
        url = typeof arguments[0] === "string" ? arguments[0] : (arguments[0] && arguments[0].url) || "";
      } catch (e) {}
      var u = String(url);
      if (u.indexOf("/property-services/property/_search") !== -1) {
        var rewritten = rewritePtSearchUrl(u);
        if (rewritten !== u) {
          if (typeof arguments[0] === "string") {
            arguments[0] = rewritten;
          } else if (arguments[0] && typeof Request !== "undefined" && arguments[0] instanceof Request) {
            try {
              arguments[0] = new Request(rewritten, arguments[0]);
            } catch (eReq) {
              arguments[0] = rewritten;
            }
          } else if (arguments[0] && arguments[0].url) {
            try {
              arguments[0] = Object.assign({}, arguments[0], { url: rewritten });
            } catch (eObj) {}
          }
          u = rewritten;
        }
      }
      if (isPtBillUrl(u)) {
        if (typeof arguments[0] === "string") arguments[0] = rewriteBillUrl(arguments[0]);
        if (arguments[1] && arguments[1].body != null) {
          var init = Object.assign({}, arguments[1]);
          init.body = enrichBillRequest(init.body);
          init.headers = Object.assign({}, init.headers || {});
          var tok = currentUser().access_token;
          if (tok) init.headers["auth-token"] = tok;
          arguments[1] = init;
        }
        u = String(typeof arguments[0] === "string" ? arguments[0] : url);
      }
      if (u.indexOf("/service-request/") !== -1) {
        return Promise.resolve(
          new Response(JSON.stringify({ Service: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      // Do NOT stub citizen mutation/_calculate — empty {} made Transfer Ownership
      // submit fail with "billing slab not present" on acknowledgement.
      if (u.indexOf("/egov-pdf/") !== -1) {
        var pdfTenant = cityTenant();
        var pdfConsumer = "";
        var pdfReceipt = "";
        try {
          var parsedPdf = new URL(u, window.location.origin);
          pdfTenant = parsedPdf.searchParams.get("tenantId") || pdfTenant;
          pdfConsumer =
            parsedPdf.searchParams.get("consumerCode") ||
            parsedPdf.searchParams.get("consumerCodes") ||
            "";
          pdfReceipt =
            parsedPdf.searchParams.get("receiptNumber") ||
            parsedPdf.searchParams.get("receiptNumbers") ||
            "";
        } catch (ePdf) {}
        return downloadPtReceipt(pdfConsumer, pdfTenant, pdfReceipt).then(function () {
          return new Response(new Blob(["ok"]), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        });
      }
      return origFetch.apply(this, arguments).then(function (res) {
        if (u.indexOf("egov-mdms-service") !== -1) {
          return res
            .clone()
            .json()
            .then(function (j) {
              patchPaymentGateway(j);
              return new Response(JSON.stringify(j), {
                status: res.status,
                statusText: res.statusText,
                headers: { "Content-Type": "application/json" },
              });
            })
            .catch(function () {
              return res;
            });
        }
        if (u.indexOf("/property-services/property/_search") !== -1) {
          return res
            .clone()
            .json()
            .then(function (j) {
              if (j && Array.isArray(j.Properties)) j.Properties.forEach(normalizeProperty);
              return new Response(JSON.stringify(j), {
                status: res.status,
                statusText: res.statusText,
                headers: { "Content-Type": "application/json" },
              });
            })
            .catch(function () {
              return res;
            });
        }
        return res;
      });
    };
  }

  if (!window.__upyogRzpXhr) {
    window.__upyogRzpXhr = true;
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (arguments.length > 1) {
        arguments[1] = rewritePtSearchUrl(rewriteBillUrl(url));
      }
      this.__upyogUrl = arguments[1];
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__upyogUrl && isPtBillUrl(this.__upyogUrl)) {
        try {
          arguments[0] = enrichBillRequest(body);
        } catch (e) {}
      }
      if (this.__upyogUrl && String(this.__upyogUrl).indexOf("/property-services/property/_update") !== -1 && body) {
        try {
          var payload = typeof body === "string" ? JSON.parse(body) : body;
          if (payload && payload.Property) {
            sanitizePropertyForUpdate(payload.Property);
            arguments[0] = typeof body === "string" ? JSON.stringify(payload) : payload;
          }
        } catch (e) {}
      }
      if (this.__upyogUrl && String(this.__upyogUrl).indexOf("egov-mdms-service") !== -1) {
        this.addEventListener("readystatechange", function () {
          if (this.readyState !== 4 || !this.responseText) return;
          try {
            var j = JSON.parse(this.responseText);
            patchPaymentGateway(j);
            var next = JSON.stringify(j);
            Object.defineProperty(this, "responseText", { value: next });
            Object.defineProperty(this, "response", { value: next });
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  function sanitizePtBillHistory(state, url) {
    var u = url == null ? "" : String(url);
    if (u.indexOf("/payment/my-bills/PT/") === -1 && u.indexOf("/payment/collect/PT") === -1) {
      return { state: state, url: url };
    }
    var city = cityTenant();
    if (u.indexOf("tenantId=") === -1) {
      u += (u.indexOf("?") >= 0 ? "&" : "?") + "tenantId=" + encodeURIComponent(city);
    }
    if (state && typeof state === "object") {
      var inner = state.state;
      if (inner && typeof inner === "object") {
        var nextInner = Object.assign({}, inner, { tenantId: city });
        delete nextInner.bill;
        state = Object.assign({}, state, { state: nextInner });
      }
    }
    return { state: state, url: u };
  }

  function sanitizePaymentSuccessUrl(state, url) {
    var u = url == null ? "" : String(url);
    if (u.indexOf("/payment/success/") === -1) return { state: state, url: url };
    if (u.indexOf("%2F") !== -1 && u.indexOf("%252F") === -1) {
      var parts = u.split("?");
      parts[0] = parts[0].replace(/%2F/g, "%252F");
      u = parts.join("?");
    }
    return { state: state, url: u };
  }

  if (!window.__upyogHistV64 && window.history && History && History.prototype) {
    window.__upyogHistV64 = true;
    var lastPtPath = "";
    function maybeClearPtWfOnNav(url) {
      try {
        var path = String(url || (window.location && window.location.pathname) || "");
        if (path.indexOf("/pt/") === -1) return;
        if (path !== lastPtPath) {
          lastPtPath = path;
          clearPtWfCache();
        }
      } catch (eNav) {}
    }
    function fixUndefinedEditUrl(url) {
      if (url == null) return url;
      var u = String(url);
      if (u.indexOf("/undefined") === -1) return url;
      if (u.indexOf("/edit-application/") !== -1) {
        return u.replace(/\/undefined(?=\/|$)/g, "/owner-details");
      }
      return u.replace(/\/undefined(?=\/|$)/g, "");
    }
    var origPushState = History.prototype.pushState;
    History.prototype.pushState = function (state, title, url) {
      var fixed = sanitizePtBillHistory(state, url);
      fixed = sanitizePaymentSuccessUrl(fixed.state, fixed.url);
      fixed.url = fixUndefinedEditUrl(fixed.url);
      maybeClearPtWfOnNav(fixed.url);
      return origPushState.call(this, fixed.state, title, fixed.url);
    };
    var origReplaceState = History.prototype.replaceState;
    History.prototype.replaceState = function (state, title, url) {
      var fixed = sanitizePtBillHistory(state, url);
      fixed = sanitizePaymentSuccessUrl(fixed.state, fixed.url);
      fixed.url = fixUndefinedEditUrl(fixed.url);
      maybeClearPtWfOnNav(fixed.url);
      return origReplaceState.call(this, fixed.state, title, fixed.url);
    };
    try {
      window.addEventListener("popstate", function () {
        maybeClearPtWfOnNav(window.location && window.location.pathname);
      });
    } catch (ePop) {}
  }

  // Digit filters actions with roles.includes(userRoleCode). Keep string codes on live WF data.
  function coercePtWfRoles(data) {
    if (!data || typeof data !== "object") return data;
    function fixList(list) {
      return normalizeNextActions(list || []);
    }
    if (Array.isArray(data.nextActions)) data.nextActions = fixList(data.nextActions);
    if (data.actionState) {
      data.actionState.nextActions = fixList(data.actionState.nextActions || data.nextActions || []);
    }
    if (data.initialActionState) {
      data.initialActionState.nextActions = fixList(
        data.initialActionState.nextActions || data.nextActions || []
      );
    }
    return data;
  }

  // Remove leftover custom Take Action UI; keep Digit's original WF_TAKE_ACTION.
  function removeCustomPtChrome() {
    try {
      [
        "upyog-pt-app-chrome",
        "upyog-pt-action-modal",
        "upyog-pt-back-fab",
        "upyog-pt-action-menu",
        "upyog-pt-ta-picker",
        "upyog-pt-ta-dialog",
      ].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      document.body.style.paddingBottom = "";
      // Unhide native Take Action if a prior patch hid it.
      var bars = document.querySelectorAll(".action-bar-wrap, .submit-bar");
      for (var bi = 0; bi < bars.length; bi++) {
        if (bars[bi].style && bars[bi].style.display === "none") {
          var txt = (bars[bi].textContent || "").toUpperCase();
          if (txt.indexOf("TAKE ACTION") !== -1 || txt.indexOf("WF_TAKE_ACTION") !== -1) {
            bars[bi].style.display = "";
          }
        }
      }
    } catch (eRm) {}
  }

  setInterval(function () {
    try {
      hookPaymentService();
    } catch (e1) {}
    try {
      stubPtTrackApis();
    } catch (e2) {}
    try {
      wrapPtMutationCalc();
    } catch (e3) {}
    try {
      wrapPtAssessmentHooks();
    } catch (e4) {}
    try {
      wrapMutateComponents();
    } catch (e5) {}
    try {
      wrapUidValidation();
    } catch (e6) {}
    try {
      patchPtUi();
    } catch (e7) {}
    try {
      stubObpsPaymentHooks();
    } catch (e8) {}
    try {
      hookReceiptDownload();
    } catch (e9) {}
    try {
      removeCustomPtChrome();
    } catch (e10) {}
  }, 400);
  try {
    hookPaymentService();
  } catch (eA) {}
  try {
    stubPtTrackApis();
  } catch (eB) {}
  try {
    wrapPtMutationCalc();
  } catch (eC) {}
  try {
    stubObpsPaymentHooks();
  } catch (eD) {}
  try {
    hookReceiptDownload();
  } catch (eE) {}
  try {
    removeCustomPtChrome();
  } catch (eF) {}
})();


/* ===== UPYOG v75 citizen PT property page fix (BEGIN) =====
 * Scope: only /digit-ui/citizen/pt/property/properties/ routes.
 * Problem: earlier search wrappers return a NEW data object every render (and {Properties:[]} while loading),
 * so the citizen PropertyInformation page (a) latches its "not ACTIVE" flag on first load (buttons hidden) and
 * (b) re-renders in a loop, which breaks the Assess financial-year radio.
 * Fix: outermost usePropertySearch wrapper that, on this route only, returns data=undefined while loading and
 * returns the previous data object when the Properties content is unchanged. No existing code is modified.
 */
(function () {
  try {
    var ROUTE = /\/digit-ui\/citizen\/pt\/property\/properties\//;
    var cache = {};
    function onRoute() {
      try { return ROUTE.test(window.location.pathname || ""); } catch (e) { return false; }
    }
    function install() {
      try {
        if (!window.Digit || !Digit.Hooks || !Digit.Hooks.pt || !Digit.Hooks.pt.usePropertySearch) return false;
        if (!Digit.Hooks.pt.__ptSearchShapeV43) return false; // wait until existing wrappers are installed
        if (Digit.Hooks.pt.__ptCitizenStableV75) return true;
        Digit.Hooks.pt.__ptCitizenStableV75 = true;
        var inner = Digit.Hooks.pt.usePropertySearch;
        Digit.Hooks.pt.usePropertySearch = function (args, config) {
          var result = inner.apply(this, arguments);
          try {
            if (!onRoute() || !result) return result;
            var key;
            try { key = JSON.stringify((args && args.filters) || args || {}); } catch (eK) { return result; }
            if (result.isLoading && !result.isFetched) {
              return Object.assign({}, result, { data: undefined });
            }
            var data = result.data;
            var sig;
            try { sig = JSON.stringify(data && data.Properties); } catch (eS) { return result; }
            var prev = cache[key];
            if (prev && prev.sig === sig) {
              if (result.data !== prev.data) return Object.assign({}, result, { data: prev.data });
              return result;
            }
            cache[key] = { sig: sig, data: data };
          } catch (eW) {}
          return result;
        };
        return true;
      } catch (e) {
        return false;
      }
    }
    if (!install()) {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (install() || tries > 300) clearInterval(t);
      }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v75 citizen PT property page fix (END) ===== */

/* ===== UPYOG v76 citizen PT assess navigation fix (BEGIN) =====
 * Scope: only while on /digit-ui/citizen/pt/property/properties/<id>.
 * Problem: the audit property search wrappers inject a placeholder property (propertyId "NA") which the stock
 * citizen page copies into its state, so Assess navigates to /citizen/pt/assessment-details/NA (PROPERTY_NOT_FOUND).
 * Fix: (1) on this route, drop placeholder "NA" rows from audit search results; (2) if navigation to
 * assessment-details/NA|undefined still happens from this route, rewrite it to the real property ID from the URL
 * (history state, which carries the selected financial year, is kept as-is). No existing code is modified.
 */
(function () {
  try {
    var ROUTE = /\/digit-ui\/citizen\/pt\/property\/properties\/([^\/?#]+)/;
    var lastPid = null;
    function routePid() {
      try {
        var m = ROUTE.exec(window.location.pathname || "");
        if (m && m[1] && m[1] !== "NA" && m[1] !== "undefined") lastPid = decodeURIComponent(m[1]);
        return m ? lastPid : null;
      } catch (e) { return null; }
    }
    function isPlaceholder(p) {
      return !p || !p.propertyId || p.propertyId === "NA";
    }
    function installSearch() {
      try {
        if (!window.Digit || !Digit.Hooks || !Digit.Hooks.pt || !Digit.Hooks.pt.usePropertySearch) return false;
        if (!Digit.Hooks.pt.__ptCitizenStableV75) return false; // stack on top of v75 block
        if (Digit.Hooks.pt.__ptCitizenNoNaV76) return true;
        Digit.Hooks.pt.__ptCitizenNoNaV76 = true;
        var inner = Digit.Hooks.pt.usePropertySearch;
        Digit.Hooks.pt.usePropertySearch = function (args, config) {
          var result = inner.apply(this, arguments);
          try {
            if (!routePid() || !result || !result.data) return result;
            var filters = (args && args.filters) || {};
            if (!filters.audit) return result;
            var data = result.data;
            var list = Array.isArray(data) ? data : Array.isArray(data.Properties) ? data.Properties : null;
            if (!list || !list.some(isPlaceholder)) return result;
            if (data.__v76Clean) return result;
            var clean = list.filter(function (p) { return !isPlaceholder(p); });
            var shaped;
            if (Array.isArray(data)) {
              shaped = clean;
            } else {
              shaped = Object.assign({}, data, { Properties: clean });
              delete shaped[0];
              delete shaped[1];
              clean.forEach(function (p, i) { shaped[i] = p; });
            }
            try { Object.defineProperty(shaped, "__v76Clean", { value: true, enumerable: false }); } catch (eD) {}
            return Object.assign({}, result, { data: shaped });
          } catch (eW) {}
          return result;
        };
        return true;
      } catch (e) { return false; }
    }
    function fixUrl(url) {
      try {
        if (url == null) return url;
        var s = String(url);
        var m = /\/digit-ui\/citizen\/pt\/assessment-details\/(NA|undefined|null)?(?=$|[?#])/.exec(s);
        if (!m) return url;
        var pid = lastPid || routePid();
        if (!pid) return url;
        return s.replace(/\/digit-ui\/citizen\/pt\/assessment-details\/(NA|undefined|null)?(?=$|[?#])/, "/digit-ui/citizen/pt/assessment-details/" + pid);
      } catch (e) { return url; }
    }
    function installNav() {
      try {
        if (window.__ptCitizenAssessNavV76) return;
        window.__ptCitizenAssessNavV76 = true;
        var H = window.History && window.History.prototype;
        if (!H) return;
        var push = H.pushState, rep = H.replaceState;
        H.pushState = function (state, title, url) {
          try { if (lastPid || routePid()) url = fixUrl(url); } catch (e) {}
          return push.call(this, state, title, url);
        };
        H.replaceState = function (state, title, url) {
          try { if (lastPid || routePid()) url = fixUrl(url); } catch (e) {}
          return rep.call(this, state, title, url);
        };
      } catch (e) {}
    }
    routePid();
    setInterval(routePid, 300);
    installNav();
    if (!installSearch()) {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (installSearch() || tries > 300) clearInterval(t);
      }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v76 citizen PT assess navigation fix (END) ===== */

/* ===== UPYOG v78 citizen PGR create: city ServiceDefs + Karjat type/Marathi subtype (BEGIN) ===== */
(function () {
  try {
    var KJT = "pg.karjat";
    var KJT_MR = {"EFR":"\u0907\u092e\u093e\u0930\u0924\u0940\u092e\u0927\u0940\u0932 \u0906\u0917\u0940\u092a\u093e\u0938\u0942\u0928 \u0938\u0941\u0930\u0915\u094d\u0937\u0947\u091a\u094d\u092f\u093e \u0906\u0930\u0915\u094d\u0937\u0940\u0924 \u091c\u093e\u0917\u0947\u0924 \u0905\u0924\u093f\u0915\u094d\u0930\u092e\u0923 \u091d\u093e\u0932\u0947\u092c\u093e\u092c\u0924","NWL":"\u092a\u093e\u0930\u094d\u0932\u0930\u094d\u0938 \u0930\u0947\u0938\u094d\u091f\u0949\u0930\u0947\u0902\u091f\u094d\u0938 \u0938\u0932\u0942\u0928\u094d\u0938 \u092a\u0930\u0935\u093e\u0928\u094d\u092f\u093e\u0936\u093f\u0935\u093e\u092f \u091a\u093e\u0932\u0942 \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","RROR":"\u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0902\u091a\u0940 \u0926\u0941\u0930\u0941\u0938\u094d\u0924\u0940 \u0906\u0923\u093f \u092a\u0941\u0928\u0930\u094d\u0930\u091a\u0928\u093e \u0915\u0930\u0923\u0947 \u092c\u093e\u092c\u0924","SWS":"\u092a\u093e\u0923\u0940 \u092a\u0941\u0930\u0935\u0920\u093e \u0915\u092e\u0940 \u0939\u094b\u0924 \u0905\u0938\u0932\u0947 \u092c\u093e\u092c\u0924","UDR":"\u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0935\u0930\u0940\u0932 \u0905\u0928\u0927\u093f\u0915\u0943\u0924 \u0916\u094b\u0926\u0915\u093e\u092e\u093e\u092c\u093e\u092c\u0924","CRC":"\u092d\u094d\u0930\u0937\u094d\u091f\u093e\u091a\u093e\u0930\u093e \u092c\u093e\u092c\u0924","USEP":"\u0926\u0941\u0915\u093e\u0928 \u0915\u093e\u0930\u0916\u093e\u0928\u094d\u092f\u093e\u0902\u091a\u094d\u092f\u093e \u0906\u0935\u093e\u0930\u093e\u0924 \u0938\u094d\u092b\u094b\u091f\u0915\u091a\u093e \u0905\u0928\u0927\u093f\u0915\u0943\u0924 \u0938\u093e\u0920\u093e \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","WLTR":"\u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0935\u0930 \u092a\u093e\u0923\u0940 \u092a\u094d\u0930\u0935\u0947\u0936 \u0915\u0930\u0923\u0947","FT":"\u091d\u093e\u0921\u093e\u091a\u0940 \u092b\u093e\u0902\u0926\u0940 / \u0935\u0943\u0915\u094d\u0937 \u092e\u094b\u0921\u0942\u0928 \u092a\u0921\u0932\u0947 \u092c\u093e\u092c\u0924","AFN":"\u0905\u0917\u094d\u0928\u093f\u0936\u092e\u0928 \u0928\u093e \u0939\u0930\u0915\u0924 \u092a\u094d\u0930\u092e\u093e\u0923\u092a\u0924\u094d\u0930\u093e\u092c\u093e\u092c\u0924","IBAP":"\u092c\u0947\u0915\u093e\u092f\u0926\u0947\u0936\u0940\u0930 \u092c\u0945\u0928\u0930 \u091c\u093e\u0939\u093f\u0930\u093e\u0924\u0940 \u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0935\u0930 \u0932\u093e\u0935\u0932\u0947 \u092c\u093e\u092c\u0924 \u0924\u0915\u094d\u0930\u093e\u0930","ENMC":"\u092e\u0928\u092a\u093e \u0915\u094d\u0937\u0947\u0924\u094d\u0930\u093e\u0924\u0940\u0932 \u0930\u094b\u0921 \u092b\u0942\u091f\u092a\u093e\u0925 \u0917\u091f\u0930\u0935\u0930 \u0905\u0924\u093f\u0915\u094d\u0930\u092e\u0923","SCCS":"\u0938\u093e\u092e\u093e\u091c\u093f\u0915 \u0915\u0932\u094d\u092f\u093e\u0923\u093e\u0938\u093e\u0920\u0940 \u0935\u0930\u093f\u0937\u094d\u0920 \u0928\u093e\u0917\u0930\u093f\u0915 \u0915\u0947\u0902\u0926\u094d\u0930","ZC":"\u091d\u094b\u0928 \u092a\u094d\u0930\u092e\u093e\u0923\u092a\u0924\u094d\u0930","NRF":"\u092f\u094b\u091c\u0928\u093e\u0902\u0938\u093e\u0920\u0940 \u0906\u0930\u094d\u0925\u093f\u0915 \u0938\u0939\u093e\u092f\u094d\u092f \u0928 \u092e\u093f\u0933\u093e\u0932\u0947\u092c\u093e\u092c\u0924","VOHR":"\u0909\u0902\u091a \u0907\u092e\u093e\u0930\u0924\u0940\u0924\u0940\u0932 \u092e\u094b\u0915\u0933\u094d\u092f\u093e\u091c\u093e\u0917\u0947\u091a\u0947 \u0909\u0932\u094d\u0932\u0902\u0918\u0928","AFMB":"\u092e\u0939\u093e\u092a\u093e\u0932\u093f\u0915\u0947\u091a\u094d\u092f\u093e \u092c\u093f\u0932\u094d\u0921\u093f\u0902\u0917\u092e\u0927\u094d\u092f\u0947 \u0906\u0922\u0933\u0932\u0947\u0932\u0947 \u0935\u093e\u092a\u0930\u093e\u0924 \u0928\u0938\u0932\u0947\u0932\u0947 \u092b\u0930\u094d\u0928\u093f\u091a\u0930 \u0938\u093e\u0939\u093f\u0924\u094d\u092f","ASND":"\u092e\u093e\u0932\u092e\u0924\u094d\u0924\u093e \u092e\u0942\u0932\u094d\u092f\u093e\u0902\u0915\u0928\u093e\u0938\u093e\u0920\u0940 \u0905\u0930\u094d\u091c \u0915\u0947\u0932\u0947 \u092a\u0930\u0902\u0924\u0941 \u0905\u0926\u094d\u092f\u093e\u092a \u0915\u0947\u0932\u0947 \u0928\u093e\u0939\u0940","OFT":"\u0936\u094c\u091a\u093e\u0932\u092f\u092e\u0927\u0942\u0928 \u0926\u0941\u0930\u094d\u0917\u0902\u0927 \u092a\u0938\u0930\u0924 \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","RMPT":"\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0936\u094c\u091a\u093e\u0932\u092f\u093e\u0902\u091a\u0940 \u0926\u0941\u0930\u0941\u0938\u094d\u0924\u0940 \u0906\u0923\u093f \u0926\u0947\u0916\u092d\u093e\u0932 \u0915\u0930\u0923\u0947 \u092c\u093e\u092c\u0924","UHF":"\u092b\u0941\u091f\u092a\u093e\u0925\u0935\u0930 \u0905\u0928\u0927\u093f\u0915\u0943\u0924 \u0939\u0949\u0915\u0930\u094d\u0938","PP":"\u092d\u093e\u0917 \u092f\u094b\u091c\u0928\u093e","REP":"\u0907\u0932\u0947\u0915\u094d\u091f\u094d\u0930\u093f\u0915 \u092a\u094b\u0932\u091a\u0940 \u0926\u0941\u0930\u0941\u0938\u094d\u0924\u0940 \u0915\u0930\u0923\u0947\u092c\u093e\u092c\u0924","NRWB":"\u092a\u093e\u0923\u0940 \u0926\u0947\u092f\u0915\u093e\u091a\u0940 \u092a\u093e\u0935\u0924\u0940 \u0928 \u092e\u093f\u0933\u093e\u0932\u0947\u092c\u093e\u092c\u0924","ZCR":"\u091d\u0947\u092c\u094d\u0930\u093e \u0915\u094d\u0930\u0949\u0938 \u0915\u0930\u0923\u0947 \u092c\u093e\u092c\u0924","TB":"\u0936\u093e\u0916\u093e \u0938\u0902\u0938\u094d\u0925\u093e \u0935\u094d\u092f\u0935\u0938\u094d\u0925\u093f\u0924 \u0915\u0930\u0923\u0947\u092c\u093e\u092c\u0924","PMT":"\u092e\u094b\u092c\u093e\u0907\u0932 \u091f\u0949\u0935\u0930\u0938\u093e\u0920\u0940 \u092a\u0930\u0935\u093e\u0928\u0917\u0940","PLR":"\u092a\u093e\u0930\u094d\u0915\u093f\u0902\u0917 \u0932\u093e\u0907\u0928 \u0906\u0935\u0936\u094d\u092f\u0915 \u0905\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924","SCRG":"\u0915\u094d\u0930\u0940\u0921\u093e \u0938\u094d\u092a\u0930\u094d\u0927\u093e \u0938\u0902\u092c\u0902\u0927\u093f\u0924 \u0924\u0915\u094d\u0930\u093e\u0930\u0940","SCDG":"\u0915\u094d\u0930\u0940\u0921\u093e \u0906\u0923\u093f \u0938\u0902\u0938\u094d\u0915\u0943\u0924\u0940 \u0938\u0902\u092c\u0902\u0927\u093f\u0924 \u0924\u0915\u094d\u0930\u093e\u0930\u0940","CC":"\u092a\u094d\u0930\u093e\u0930\u0902\u092d \u092a\u094d\u0930\u092e\u093e\u0923\u092a\u0924\u094d\u0930","OC":"\u092d\u094b\u0917\u0935\u091f\u093e \u092a\u094d\u0930\u092e\u093e\u0923\u092a\u0924\u094d\u0930","EIS":"\u0938\u094b\u0938\u093e\u092f\u091f\u0940 \u092e\u0927\u094d\u092f\u0947 \u0905\u0924\u093f\u0915\u094d\u0930\u092e\u0923 \u0915\u0947\u0932\u0947\u092c\u093e\u092c\u0924","DTBL":"\u092e\u094b\u0921\u0924\u094b\u0921 \u0909\u0926\u094d\u0930\u0947\u0915 \u0939\u094b\u0923\u0947","RDB":"\u0928\u093f\u0937\u094d\u0915\u093e\u0933\u091c\u0940\u092a\u0923\u0947 \u092c\u0938\u091a\u0947 \u0935\u093e\u0939\u0928 \u091a\u093e\u0932\u0935\u093f\u0923\u0947","CPWP":"\u0915\u094b\u0923\u0924\u094d\u092f\u093e\u0939\u0940 \u092a\u0930\u0935\u093e\u0928\u0917\u0940\u0936\u093f\u0935\u093e\u092f \u0916\u0947\u0933\u093e\u091a\u0947 \u092e\u0948\u0926\u093e\u0928 \u0909\u0926\u094d\u092f\u093e\u0928\u093e\u091a\u0947 \u092c\u093e\u0902\u0927\u0915\u093e\u092e \u0915\u0947\u0932\u094d\u092f\u093e\u091a\u0940 \u0924\u0915\u094d\u0930\u093e\u0930","BBC":"\u092c\u0938\u091a\u0940 \u0905\u0935\u0938\u094d\u0925\u093e \u0916\u0930\u093e\u092c \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","CRBF":"\u0935\u093e\u0939\u0915\u093e\u0928\u0947 \u0936\u093f\u0932\u094d\u0932\u0915 \u0930\u0915\u092e\u0947\u091a\u0940 \u092a\u0930\u0924\u092b\u0947\u0921 \u0915\u0947\u0932\u0940 \u0928\u093e\u0939\u0940","BRDB":"\u092c\u094b\u0930\u094d\u0921 \u0906\u0923\u093f \u0928\u0902\u092c\u0930 \u0936\u093f\u0935\u093e\u092f \u092c\u0938\u0917\u093e\u0921\u094d\u092f\u093e \u091a\u093e\u0932\u0924 \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","RBS":"\u092c\u0938 \u0938\u094d\u091f\u0949\u092a \u092c\u0938 \u0906\u0936\u094d\u0930\u092f \u092f\u093e\u0935\u093f\u0937\u092f\u0940","RBC":"\u0924\u0941\u091f\u0932\u0947\u0932\u0940 \u091a\u0947\u0902\u092c\u0930\u094d\u0938 \u0926\u0941\u0930\u0941\u0938\u094d\u0924 \u0915\u0930\u0923\u0947\u092c\u093e\u092c\u0924","SLWN":"\u0928\u093e\u0932\u094d\u092f\u093e\u0924\u0940\u0932 \u092a\u093e\u0923\u094d\u092f\u093e\u091a\u093e \u0928\u093f\u091a\u0930\u093e \u0925\u093e\u0902\u092c\u0935\u093f\u0923\u0947 \u092c\u093e\u092c\u0924","WAPT":"\u092e\u093e\u0932\u092e\u0924\u094d\u0924\u093e \u0915\u0930\u093e\u091a\u0947 \u091a\u0941\u0915\u0940\u091a\u0947 \u092e\u0942\u0932\u094d\u092f\u092e\u093e\u092a\u0928","PC":"\u091c\u094b\u0924\u0947 \u092a\u094d\u0930\u092e\u093e\u0923\u092a\u0924\u094d\u0930","ATBP":"\u092a\u0930\u0935\u093e\u0928\u0917\u0940 \u0936\u093f\u0935\u093e\u092f \u092e\u0939\u093e\u092a\u093e\u0932\u093f\u0915\u093e \u0907\u092e\u093e\u0930\u0924\u0940\u0924 \u0935\u093e\u0922 \u092c\u0926\u0932","OPPT":"\u092e\u093e\u0932\u092e\u0924\u094d\u0924\u093e \u0915\u0930\u093e\u091a\u0947 \u0911\u0928\u0932\u093e\u0908\u0928 \u092a\u0947\u092e\u0947\u0902\u091f \u0915\u0947\u0932\u0947 \u092a\u0930\u0902\u0924\u0941 \u092a\u0947\u092e\u0947\u0902\u091f \u092a\u094b\u0938\u094d\u091f \u091d\u093e\u0932\u0947 \u0928\u093e\u0939\u0940","NAPT":"\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0936\u094c\u091a\u093e\u0932\u092f\u093e\u092e\u0927\u094d\u092f\u0947 \u0915\u0930\u094d\u092e\u091a\u093e\u0930\u0940 \u0909\u092a\u0938\u094d\u0925\u093f\u0924 \u0928\u0938\u0932\u0947\u092c\u093e\u092c\u0924","SLNW":"\u0938\u094d\u091f\u094d\u0930\u0940\u091f \u0932\u093e\u0908\u091f \u0915\u093e\u0930\u094d\u092f\u0930\u0924 \u0928\u0938\u0932\u0947\u092c\u093e\u092c\u0924","DWB":"\u092e\u093e\u0932\u092e\u0924\u094d\u0924\u093e \u092b\u0949\u0930\u094d\u092e / \u092a\u093e\u0923\u0940 \u092c\u093f\u0932\u093e\u092c\u093e\u092c\u0924 \u0906\u0915\u094d\u0937\u0947\u092a","RWM":"\u0928\u0933\u091c\u094b\u0921\u0923\u0940\u091a\u0947 \u092e\u0940\u091f\u0930 \u0915\u093e\u0922\u0923\u0947","OOT":"\u0913\u0935\u094d\u0939\u0930\u0939\u0947\u0921 \u091f\u093e\u0915\u0940\u091a\u093e \u0913\u0935\u094d\u0939\u0930\u092b\u094d\u0932\u094b","POR":"\u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0935\u0930 \u0916\u0921\u094d\u0921\u0947 \u092a\u0921\u0932\u0947\u092c\u093e\u092c\u0924","SSLN":"\u0930\u093e\u0924\u094d\u0930\u0940\u091a\u094d\u092f\u093e \u0935\u0947\u0933\u0940 \u0930\u0938\u094d\u0924\u094d\u092f\u093e\u0902\u0935\u0930\u0940\u0932 \u0926\u093f\u0935\u0947 \u0938\u0941\u0930\u0941 \u0905\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924","CPAP":"\u0938\u0902\u0915\u0932\u0928 \u0920\u093f\u0915\u093e\u0923\u093e\u0935\u0930 \u092f\u094b\u0917\u094d\u092f \u0909\u092a\u0938\u094d\u0925\u093f\u0924 \u0928\u0938\u0932\u0947\u092c\u093e\u092c\u0924","MON":"\u092e\u091a\u094d\u091b\u0930\u093e\u0902\u091a\u093e \u0909\u092a\u0926\u094d\u0930\u0935 \u0939\u094b\u0924 \u0905\u0938\u0932\u0947\u092c\u093e\u092c\u0924","PRGS":"\u0928\u093f\u0935\u0943\u0924\u094d\u0924\u0940\u0935\u0947\u0924\u0928 \u0938\u0902\u092c\u0902\u0927\u093f\u0924 \u0924\u0915\u094d\u0930\u093e\u0930\u0940 \u0936\u093e\u0933\u0947\u091a\u094d\u092f\u093e \u0915\u0930\u094d\u092e\u091a\u093e\u0930\u094d\u092f\u093e\u0902\u0938\u093e\u0920\u0940","TRG":"\u0915\u0930\u094d\u092e\u091a\u093e\u0930\u0940 \u0936\u093f\u0915\u094d\u0937\u0915 \u0938\u0902\u092c\u0902\u0927\u093f\u0924 \u0924\u0915\u094d\u0930\u093e\u0930\u0940","WLBT":"\u090f\u0932\u092c\u0940\u091f\u0940 \u0915\u0930\u093e\u091a\u0947 \u091a\u0941\u0915\u0940\u091a\u0947 \u092e\u0942\u0932\u094d\u092f\u092e\u093e\u092a\u0928","SM":"\u0938\u093e\u0939\u093f\u0924\u094d\u092f\u093e\u091a\u093e \u0938\u093e\u0920\u093e","RWND":"\u0930\u0938\u094d\u0924\u094d\u092f\u093e\u091a\u0940 \u0938\u093e\u092b\u0938\u092b\u093e\u0908 \u0939\u094b\u0924 \u0928\u0938\u0932\u0947\u092c\u093e\u092c\u0924","PL":"\u092a\u093e\u0908\u092a\u0932\u093e\u0908\u0928 \u0917\u0933\u0924\u0940","RDM":"\u0916\u0930\u093e\u092c \u091d\u093e\u0932\u0947\u0932\u0947 / \u0909\u0918\u0921\u0947 \u092e\u0945\u0928\u0939\u094b\u0932","DDS":"\u0928\u093e\u0932\u094d\u092f\u093e\u091a\u0947 \u0938\u094d\u0932\u0945\u092c \u0916\u0930\u093e\u092c \u091d\u093e\u0932\u0947 \u092c\u093e\u092c\u0924","VFS":"\u0905\u0917\u094d\u0928\u093f\u0938\u0941\u0930\u0915\u094d\u0937\u093e \u0915\u093e\u092f\u0926\u094d\u092f\u093e\u091a\u0947 \u0909\u0932\u094d\u0932\u0902\u0918\u0928","SWM_GHANTAGADI":"\u0918\u0902\u091f\u093e\u0917\u093e\u0921\u0940 \u092f\u0947\u0924 \u0928\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924","SWM_KACHRA":"\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0920\u093f\u0915\u093e\u0923\u093e\u0935\u0930\u0940\u0932 \u0915\u091a\u0930\u093e \u0909\u091a\u0932\u0932\u093e \u0928\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924","SWM_01":"\u0918\u0902\u091f\u093e\u0917\u093e\u0921\u0940 \u092f\u0947\u0924 \u0928\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924","SWM_02":"\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0920\u093f\u0915\u093e\u0923\u093e\u0935\u0930\u0940\u0932 \u0915\u091a\u0930\u093e \u0909\u091a\u0932\u0932\u093e \u0928\u0938\u0932\u094d\u092f\u093e\u092c\u093e\u092c\u0924"};
    function isCreatePage() {
      return /\/digit-ui\/citizen\/pgr\/create-complaint/.test(String((window.location && window.location.pathname) || ""));
    }
    function isCity(t) { return !!(t && String(t).indexOf(".") !== -1); }
    function citizenCity() {
      try {
        var h = Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY");
        if (h && isCity(h.code)) return String(h.code);
        var u = Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
        var pc = u && u.info && u.info.permanentCity;
        if (isCity(pc)) return String(pc);
      } catch (e) {}
      return "pg";
    }
    function install() {
      if (!window.Digit || !Digit.GetServiceDefinitions || !Digit.GetServiceDefinitions.getMenu || !Digit.GetServiceDefinitions.getSubMenu || !Digit.Hooks || !Digit.Hooks.pgr || !Digit.Hooks.pgr.useTenants || !Digit.SessionStorage) return false;
      var G = Digit.GetServiceDefinitions;
      if (G.__citizenCreateV78) return true;
      G.__citizenCreateV78 = true;
      var origGet = G.get, origMenu = G.getMenu, origSub = G.getSubMenu, origTenants = Digit.Hooks.pgr.useTenants;
      G.getMenu = function (tenantId, t) {
        if (!isCreatePage()) return origMenu.apply(this, arguments);
        var city = citizenCity();
        if (city !== KJT) return origMenu.call(this, isCity(city) ? city : tenantId, t);
        return Promise.resolve(origGet.call(G, KJT)).then(function (defs) {
          return (defs || []).map(function (d) { return { key: d.serviceCode, name: d.name || d.serviceCode, menuPath: d.menuPath }; });
        });
      };
      G.getSubMenu = function (tenantId, type, t) {
        if (!isCreatePage()) return origSub.apply(this, arguments);
        var city = citizenCity();
        var code = type && type.key;
        if (city === KJT && code && Object.prototype.hasOwnProperty.call(KJT_MR, code)) {
          return Promise.resolve([{ key: code, name: KJT_MR[code] }]);
        }
        return origSub.call(this, isCity(city) ? city : tenantId, type, t);
      };
      Digit.Hooks.pgr.useTenants = function () {
        var list = origTenants.apply(this, arguments);
        if (!isCreatePage() || citizenCity() !== KJT || !Array.isArray(list)) return list;
        var only = list.filter(function (x) { return x && x.code === KJT; });
        return only.length ? only : list;
      };
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v78 citizen PGR create (END) ===== */

/* ===== UPYOG v79 citizen PGR: fresh create form + acknowledgement PDF from the real complaint (BEGIN) ===== */
(function () {
  try {
    var CREATE_RE = /\/digit-ui\/citizen\/pgr\/create-complaint(\/|$)/;
    var RESP_RE = /\/digit-ui\/citizen\/pgr\/create-complaint\/response\/?$/;
    var LAST_KEY = "pgrLastCreatedV79";
    function isCreateStep(p) { return CREATE_RE.test(p) && !RESP_RE.test(p); }
    function isResp(p) { return RESP_RE.test(p); }
    function isCity(t) { return !!(t && String(t).indexOf(".") !== -1); }
    function citizenCity() {
      try {
        var h = Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY");
        if (h && isCity(h.code)) return String(h.code);
        var u = Digit.UserService.getUser();
        if (u && u.info && isCity(u.info.permanentCity)) return String(u.info.permanentCity);
      } catch (e) {}
      return "";
    }
    function clearCreateState() {
      try {
        var S = window.Digit && Digit.SessionStorage;
        ["PGR_CITIZEN_CREATE_COMPLAINT", "city_complaint", "selected_localities"].forEach(function (k) {
          try { if (S && S.del) S.del(k); else if (S) S.set(k, undefined); } catch (e) {}
          try { window.sessionStorage.removeItem("Digit." + k); } catch (e) {}
        });
        window.sessionStorage.removeItem("complaintType");
      } catch (e) {}
    }
    var lastPath = String(window.location.pathname || "");
    function pathOf(url) {
      if (url === undefined || url === null || url === "") return null;
      try { return new URL(String(url), window.location.href).pathname; } catch (e) { return null; }
    }
    function wrap(name) {
      var orig = window.history[name];
      if (!orig || orig.__pgrFreshV79) return;
      var w = function (state, title, url) {
        var next = pathOf(url);
        if (next !== null) {
          var prev = lastPath;
          if (isCreateStep(next) && (!CREATE_RE.test(prev) || isResp(prev))) {
            clearCreateState();
            if (isResp(prev)) { lastPath = next; window.location.assign(String(url)); return; }
          }
          var r = orig.apply(this, arguments);
          lastPath = next;
          if (isResp(next) && !isResp(prev)) clearCreateState();
          return r;
        }
        return orig.apply(this, arguments);
      };
      w.__pgrFreshV79 = true;
      window.history[name] = w;
    }
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", function () {
      var prev = lastPath, next = String(window.location.pathname || "");
      lastPath = next;
      if (isCreateStep(next) && isResp(prev)) { clearCreateState(); window.location.reload(); }
      else if (isCreateStep(next) && !CREATE_RE.test(prev)) clearCreateState();
    });

    /* remember the complaint just created (id + tenant) for the acknowledgement */
    function wrapCreate() {
      if (!window.Digit || !Digit.Complaint || !Digit.Complaint.create) return false;
      if (Digit.Complaint.__pgrAckV79) return true;
      Digit.Complaint.__pgrAckV79 = true;
      var oc = Digit.Complaint.create;
      Digit.Complaint.create = function (args) {
        return Promise.resolve(oc.apply(this, arguments)).then(function (res) {
          try {
            var s = res && res.ServiceWrappers && res.ServiceWrappers[0] && res.ServiceWrappers[0].service;
            if (s && s.serviceRequestId) window.sessionStorage.setItem(LAST_KEY, JSON.stringify({ id: s.serviceRequestId, tenantId: s.tenantId || (args && args.cityCode) }));
          } catch (e) {}
          return res;
        });
      };
      return true;
    }

    function post(url, body) {
      return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    }
    function reqInfo() {
      var u = {};
      try { u = Digit.UserService.getUser() || {}; } catch (e) {}
      return { apiId: "Rainmaker", authToken: u.access_token, msgId: "pgr-ack-v79" };
    }
    var tenantsP = null;
    function tenantInfo(code) {
      if (!tenantsP) {
        tenantsP = post("/egov-mdms-service/v1/_search?tenantId=pg", { RequestInfo: reqInfo(), MdmsCriteria: { tenantId: "pg", moduleDetails: [{ moduleName: "tenant", masterDetails: [{ name: "tenants" }] }] } })
          .then(function (d) { return (d && d.MdmsRes && d.MdmsRes.tenant && d.MdmsRes.tenant.tenants) || []; })
          .catch(function () { tenantsP = null; return []; });
      }
      return tenantsP.then(function (l) { return l.filter(function (x) { return x && x.code === code; })[0] || null; });
    }
    function mrLabel(key) {
      return post("/localization/messages/v1/_search?locale=mr_IN&tenantId=pg&module=rainmaker-pgr", { RequestInfo: {} })
        .then(function (d) { var m = ((d && d.messages) || []).filter(function (x) { return x.code === key; })[0]; return m ? m.message : null; })
        .catch(function () { return null; });
    }
    function boundaryName(tid, code) {
      if (!code || !Digit.LocationService || !Digit.LocationService.getLocalities) return Promise.resolve(null);
      return Promise.resolve(Digit.LocationService.getLocalities(tid))
        .then(function (r) {
          var found = null;
          (function walk(list) {
            (list || []).forEach(function (n) { if (found || !n) return; if (n.code === code) found = n.name; else walk(n.children); });
          })(((r && r.TenantBoundary) || []).map(function (tb) { return { children: tb.boundary }; }));
          return found;
        })
        .catch(function () { return null; });
    }
    function findComplaint(id, tenants) {
      var i = 0;
      function next() {
        if (i >= tenants.length) return Promise.resolve(null);
        var tid = tenants[i++];
        return Promise.resolve(Digit.PGRService.search(tid, { serviceRequestId: id }))
          .then(function (r) {
            var w = r && r.ServiceWrappers && r.ServiceWrappers[0];
            return w && w.service && w.service.serviceRequestId === id ? w.service : next();
          })
          .catch(next);
      }
      return next();
    }

    function ackData(D, stockTenant, t) {
      t = typeof t === "function" ? t : function (k) { return k; };
      function tt(k, fb) { var v = k ? t(k) : ""; return !v || v === k ? fb : v; }
      var NA = tt("CS_NA", "NA");
      var last = {};
      try { last = JSON.parse(window.sessionStorage.getItem(LAST_KEY) || "{}") || {}; } catch (e) {}
      var id = (D && D.service && D.service.serviceRequestId) || last.id;
      if (!id) {
        var m = String((document.body && document.body.innerText) || "").match(/PG-PGR-\d{4}-\d{2}-\d{2}-\d+/);
        id = m && m[0];
      }
      var cands = [];
      [id && last.id === id ? last.tenantId : null, D && D.service && D.service.tenantId, citizenCity(), "pg.citya"].forEach(function (x) {
        if (isCity(x) && cands.indexOf(x) === -1) cands.push(x);
      });
      return (id ? findComplaint(id, cands) : Promise.resolve(null)).then(function (svc) {
        svc = svc || (D && D.service) || {};
        var tid = svc.tenantId || cands[0] || "pg.citya";
        var code = svc.serviceCode || "";
        return Promise.all([
          tenantInfo(tid),
          Promise.resolve(code ? Digit.MDMSService.getServiceDefs(tid, "PGR") : []).catch(function () { return []; }),
          tid === "pg.karjat" && code ? mrLabel("SERVICEDEFS." + code.toUpperCase()) : Promise.resolve(null),
          boundaryName(tid, svc.address && svc.address.locality && svc.address.locality.code),
        ]).then(function (res) {
          var ten = res[0] || stockTenant || {};
          var def = ((res[1] || []).filter(function (d) { return d && d.serviceCode === code; })[0]) || {};
          var typeTxt, subTxt;
          if (tid === "pg.karjat") {
            typeTxt = def.name || tt("SERVICEDEFS." + code.toUpperCase(), code || NA);
            subTxt = res[2] || tt("SERVICEDEFS." + code.toUpperCase(), def.name || code || NA);
          } else {
            typeTxt = def.menuPath ? tt("SERVICEDEFS." + String(def.menuPath).toUpperCase(), def.menuPath) : NA;
            subTxt = code ? tt("SERVICEDEFS." + code.toUpperCase(), def.name || code) : NA;
          }
          var tkey = "TENANT_TENANTS_" + String(tid).replace(".", "_").toUpperCase();
          var cityName = tt(tkey, (ten.city && ten.city.name) || ten.name || tid);
          var grade = ten.city && ten.city.ulbGrade ? tt("ULBGRADE_" + String(ten.city.ulbGrade).toUpperCase().replace(" ", "_").replace(".", "_"), ten.city.ulbGrade) : "";
          grade = String(grade).toLowerCase().split(" ").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
          var header = grade && cityName.toLowerCase().indexOf(grade.toLowerCase()) === -1 ? cityName + " " + grade : cityName;
          var a = svc.address || {};
          var loc = a.locality || {};
          var pfx = String(tid).replace(".", "_").toUpperCase();
          var locTxt = loc.code ? tt(pfx + "_ADMIN_" + loc.code, tt(pfx + "_REVENUE_" + loc.code, loc.name || res[3] || loc.code)) : NA;
          var created = svc.auditDetails && svc.auditDetails.createdTime;
          var filed = NA;
          try { if (created) filed = Digit.DateUtils.ConvertTimestampToDate(created, "dd/MM/yyyy"); } catch (e) {}
          return {
            t: t,
            tenantId: tid,
            name: header,
            email: ten.emailId || "",
            phoneNumber: ten.contactNumber || "",
            heading: tt("PGR_ACKNOWLEDGEMENT", "Complaint Acknowledgement"),
            details: [
              {
                title: tt("CS_TITLE_APPLICATION_DETAILS", "Application Details"),
                values: [
                  { title: tt("PGR_APPLICATION_NO", "Complaint No."), value: svc.serviceRequestId || id || NA },
                  { title: tt("CS_COMPLAINT_FILED_DATE", "Filed Date"), value: filed },
                  { title: tt("CS_COMPLAINT_TYPE", "Complaint Type"), value: typeTxt || NA },
                  { title: tt("CS_COMPLAINT_SUB_TYPE", "Complaint Sub-Type"), value: subTxt || NA },
                  { title: tt("CS_COMPLAINT_ADDITIONAL_DETAILS", "Additional Details"), value: svc.description || NA },
                ],
              },
              {
                title: tt("PGR_ADDRESS_SUB_HEADER", "Address Details"),
                values: [
                  { title: tt("PGR_ADDRESS_PINCODE", "Pincode"), value: a.pincode || NA },
                  { title: tt("PT_ADDRESS_CITY", "City"), value: cityName || NA },
                  { title: tt("PT_ADDRESS_MOHALLA", "Locality / Mohalla"), value: locTxt || NA },
                  { title: tt("PGR_ADDRESS_STREET_NAME", "Street Name"), value: a.street || NA },
                  { title: tt("PGR_ADDRESS_HOUSE_NO", "House No."), value: a.doorNo || NA },
                  { title: tt("PGR_ADDRESS_LANDMARK", "Landmark"), value: a.landmark || NA },
                ],
              },
            ],
          };
        });
      });
    }
    window.getPGRcknowledgementData = ackData;
    var n = 0;
    var iv = setInterval(function () {
      n++;
      if (window.getPGRcknowledgementData !== ackData) window.getPGRcknowledgementData = ackData;
      var ok = wrapCreate();
      if ((ok && n > 50) || n > 600) clearInterval(iv);
    }, 100);
  } catch (eOuter) {}
})();
/* ===== UPYOG v79 citizen PGR (END) ===== */

/* ===== UPYOG v80 citizen PGR success page: route the stock ack PDF through the v79 builder (BEGIN) ===== */
(function () {
  try {
    var RESP_RE = /\/digit-ui\/citizen\/pgr\/create-complaint\/response\/?$/;
    function install() {
      var P = window.Digit && Digit.Utils && Digit.Utils.pdf;
      if (!P || typeof P.generate !== "function") return false;
      if (P.generate.__pgrAckV80) return true;
      var orig = P.generate;
      var w = function (arg) {
        var self = this, args = arguments;
        try {
          var onResp = RESP_RE.test(String(window.location.pathname || ""));
          var tf = arg && typeof arg.t === "function" ? arg.t : null;
          var isPgrAck = arg && tf && arg.heading === tf("PGR_ACKNOWLEDGEMENT");
          if (onResp && isPgrAck && typeof window.getPGRcknowledgementData === "function") {
            return Promise.resolve(window.getPGRcknowledgementData({}, null, tf))
              .then(function (fixed) { return orig.call(self, fixed && fixed.details ? fixed : arg); })
              .catch(function () { return orig.apply(self, args); });
          }
        } catch (e) {}
        return orig.apply(self, args);
      };
      w.__pgrAckV80 = true;
      P.generate = w;
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v80 citizen PGR success page (END) ===== */

/* ===== UPYOG v81 citizen PGR success page: ack data from the create response when _search fails (BEGIN) ===== */
(function () {
  try {
    var RESP_RE = /\/digit-ui\/citizen\/pgr\/create-complaint\/response\/?$/;
    var KEY = "pgrLastServiceV81";
    function stored(id) {
      try {
        var s = JSON.parse(window.sessionStorage.getItem(KEY) || "null");
        return s && s.serviceRequestId && (!id || s.serviceRequestId === id) ? s : null;
      } catch (e) { return null; }
    }
    function install() {
      if (!window.Digit || !Digit.Complaint || !Digit.Complaint.create || !Digit.PGRService || !Digit.PGRService.search) return false;
      if (!Digit.Complaint.__pgrSvcV81) {
        Digit.Complaint.__pgrSvcV81 = true;
        var oc = Digit.Complaint.create;
        Digit.Complaint.create = function () {
          return Promise.resolve(oc.apply(this, arguments)).then(function (res) {
            try {
              var s = res && res.ServiceWrappers && res.ServiceWrappers[0] && res.ServiceWrappers[0].service;
              if (s && s.serviceRequestId) {
                var c = JSON.parse(JSON.stringify(s));
                delete c.citizen;
                window.sessionStorage.setItem(KEY, JSON.stringify(c));
              }
            } catch (e) {}
            return res;
          });
        };
      }
      var S = Digit.PGRService;
      if (!S.search.__pgrSvcV81) {
        var os = S.search;
        var w = function (tenantId, filters) {
          var p = Promise.resolve().then(function () { return os.call(S, tenantId, filters); });
          if (!RESP_RE.test(String(window.location.pathname || ""))) return p;
          var id = filters && filters.serviceRequestId;
          function fb(r) {
            var has = r && r.ServiceWrappers && r.ServiceWrappers.length;
            var s = !has && stored(id);
            if (s && (!tenantId || tenantId === s.tenantId)) return { ServiceWrappers: [{ service: s, workflow: { action: "APPLY" } }] };
            if (r) return r;
            throw new Error("PGR search failed");
          }
          return p.then(fb, function () { return fb(null); });
        };
        w.__pgrSvcV81 = true;
        S.search = w;
      }
      return true;
    }
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var ok = install();
      if ((ok && n > 50) || n > 600) clearInterval(iv);
    }, 100);
  } catch (eOuter) {}
})();
/* ===== UPYOG v81 citizen PGR success page (END) ===== */

/* ===== UPYOG v82 citizen PGR rate page: complaint via _plainsearch when _search fails (BEGIN) ===== */
(function () {
  try {
    var RATE_RE = /\/digit-ui\/citizen\/pgr\/rate\//;
    var KJT = "pg.karjat";
    function onRate() { return RATE_RE.test(String(window.location.pathname || "")); }
    function user() { try { return Digit.UserService.getUser() || null; } catch (e) { return null; } }
    function plain(tenantId, id) {
      var u = user();
      var tok = u && u.access_token;
      var me = u && u.info && u.info.uuid;
      if (!tok || !me || !id) return Promise.resolve(null);
      var ts = [KJT];
      if (tenantId && tenantId !== KJT && String(tenantId).indexOf(".") > 0) ts.push(tenantId);
      var url = "/pgr-services/v2/request/_plainsearch?tenantIds=" + encodeURIComponent(ts.join(",")) + "&serviceRequestId=" + encodeURIComponent(id);
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ RequestInfo: { apiId: "Rainmaker", authToken: tok, userInfo: u.info } })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        var list = (j && j.ServiceWrappers) || [];
        var keep = [];
        for (var i = 0; i < list.length; i++) {
          var s = list[i] && list[i].service;
          if (s && s.serviceRequestId === id && s.accountId === me) keep.push({ service: s, workflow: list[i].workflow || {} });
        }
        return keep.length ? { ServiceWrappers: keep } : null;
      }, function () { return null; });
    }
    function install() {
      if (!window.Digit || !Digit.PGRService || !Digit.PGRService.search || !Digit.MDMSService || !Digit.MDMSService.getServiceDefs) return false;
      var S = Digit.PGRService;
      if (!S.search.__pgrRateV82) {
        var os = S.search;
        var w = function (tenantId, filters) {
          var p = Promise.resolve().then(function () { return os.apply(S, arguments); }.bind(null, tenantId, filters));
          if (!onRate()) return p;
          var id = filters && filters.serviceRequestId;
          if (!id) return p;
          function fb(r, err) {
            if (r && r.ServiceWrappers && r.ServiceWrappers.length) return r;
            return plain(tenantId, id).then(function (x) {
              if (x) return x;
              if (r) return r;
              throw err || new Error("PGR search failed");
            });
          }
          return p.then(function (r) { return fb(r, null); }, function (e) { return fb(null, e); });
        };
        w.__pgrRateV82 = true;
        S.search = w;
      }
      var M = Digit.MDMSService;
      if (!M.getServiceDefs.__pgrRateV82) {
        var og = M.getServiceDefs;
        var g = function (tenantId, moduleCode) {
          var p = Promise.resolve(og.apply(M, arguments));
          if (!onRate() || tenantId === KJT) return p;
          return p.then(function (a) {
            return Promise.resolve(og.call(M, KJT, moduleCode)).then(function (k) {
              var out = Array.isArray(a) ? a.slice() : [];
              var seen = {};
              for (var i = 0; i < out.length; i++) if (out[i] && out[i].serviceCode) seen[out[i].serviceCode] = 1;
              if (Array.isArray(k)) for (var j = 0; j < k.length; j++) if (k[j] && k[j].serviceCode && !seen[k[j].serviceCode]) out.push(k[j]);
              return out;
            }, function () { return a; });
          });
        };
        g.__pgrRateV82 = true;
        M.getServiceDefs = g;
      }
      return true;
    }
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var ok = install();
      if ((ok && n > 50) || n > 600) clearInterval(iv);
    }, 100);
  } catch (eOuter) {}
})();
/* ===== UPYOG v82 citizen PGR rate page (END) ===== */

/* ===== UPYOG v83 citizen PGR complaint summary: Rate/Reopen links on the RESOLVED/REJECTED step (BEGIN) ===== */
(function () {
  try {
    var PATH_RE = /^\/digit-ui\/citizen\/pgr\/complaints\/[^\/]+/;
    var ALLOWED = { RATE: true, REOPEN: true };
    function onSummary() {
      try { return PATH_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function latestPi(pis) {
      var best = null, bt = -1;
      for (var i = 0; i < pis.length; i++) {
        var pi = pis[i];
        if (!pi) continue;
        var t = (pi.auditDetails && (pi.auditDetails.lastModifiedTime || pi.auditDetails.createdTime)) || 0;
        if (best === null || t > bt) { best = pi; bt = t; }
      }
      return best;
    }
    function citizenActions(pi) {
      var out = [];
      var list = (pi && Array.isArray(pi.nextActions)) ? pi.nextActions : [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || typeof a !== "object") continue;
        var roles = Array.isArray(a.roles) ? a.roles.map(function (r) { return r && typeof r === "object" ? r.code : r; }) : [];
        if (roles.indexOf("CITIZEN") === -1) continue;
        if (!ALLOWED[a.action] || out.indexOf(a.action) !== -1) continue;
        out.push(a.action);
      }
      return out;
    }
    function fill(data) {
      if (!data || typeof data !== "object" || !Array.isArray(data.timeline)) return;
      var pis = Array.isArray(data.processInstances) ? data.processInstances : [];
      if (!pis.length) return;
      var pi = latestPi(pis);
      var status = pi && pi.state && pi.state.applicationStatus;
      if (status !== "RESOLVED" && status !== "REJECTED") return;
      var acts = citizenActions(pi);
      if (!acts.length) return;
      // the stock timeline only renders links on the first two steps (index <= 1)
      for (var i = 0; i < data.timeline.length && i <= 1; i++) {
        var step = data.timeline[i];
        if (!step || step.status !== status) continue;
        if (Array.isArray(step.timeLineActions) && step.timeLineActions.length) return;
        step.timeLineActions = acts.slice();
        return;
      }
    }
    function install() {
      if (!window.Digit || !Digit.Hooks || !Digit.Hooks.useWorkflowDetails || !Digit.Hooks.__pgrWfDetailsV71) return false;
      if (Digit.Hooks.__pgrCitizenRateV83) return true;
      Digit.Hooks.__pgrCitizenRateV83 = true;
      var prev = Digit.Hooks.useWorkflowDetails;
      Digit.Hooks.useWorkflowDetails = function (params) {
        var result = prev.apply(this, arguments);
        try {
          if (result && result.data && params && params.moduleCode === "PGR" && onSummary()) fill(result.data);
        } catch (e) {}
        return result;
      };
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v83 citizen PGR complaint summary (END) ===== */

/* ===== UPYOG v85 employee PGR complaint details: Take Action from the latest step only, role-filtered (BEGIN) ===== */
(function () {
  try {
    var PATH_RE = /^\/digit-ui\/employee\/pgr\/complaint\/details\/[^\/]+/;
    function onDetails() {
      try { return PATH_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function code(r) { return r && typeof r === "object" ? r.code : r; }
    function userRoles() {
      try {
        var u = Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
        var roles = u && u.info && u.info.roles;
        return Array.isArray(roles) ? roles : [];
      } catch (e) { return []; }
    }
    // same rule as egov-workflow WorkflowUtil.isTenantIdValid: exact tenant or its state prefix
    function tenantOk(roleTenant, appTenant) {
      if (!roleTenant || !appTenant) return false;
      roleTenant = String(roleTenant).toLowerCase(); appTenant = String(appTenant).toLowerCase();
      return roleTenant === appTenant || roleTenant === appTenant.split(".")[0];
    }
    function latestPi(pis) {
      var best = null, bt = -1;
      for (var i = 0; i < pis.length; i++) {
        var pi = pis[i];
        if (!pi) continue;
        var t = Number((pi.auditDetails && (pi.auditDetails.lastModifiedTime || pi.auditDetails.createdTime)) || 0);
        if (best === null || t > bt) { best = pi; bt = t; }
      }
      return best;
    }
    function shape(a) {
      var b = Object.assign({}, a);
      b.roles = (Array.isArray(a.roles) ? a.roles : []).map(code).filter(Boolean);
      if (!Array.isArray(b.assigneeRoles) || !b.assigneeRoles.length) b.assigneeRoles = a.action === "ASSIGN" ? ["PGR_LME"] : [];
      else b.assigneeRoles = b.assigneeRoles.map(code).filter(Boolean);
      if (typeof b.isTerminateState !== "boolean") b.isTerminateState = a.action === "REJECT";
      if (a.action === "REJECT") b.isTerminateState = true;
      return b;
    }
    function allowedActions(pi, roles) {
      var src = Array.isArray(pi.nextActions) && pi.nextActions.length ? pi.nextActions : null;
      if (src) return src.filter(function (a) { return a && a.action; });
      var sa = (pi.state && Array.isArray(pi.state.actions)) ? pi.state.actions : [];
      var mine = roles.filter(function (r) { return tenantOk(r && r.tenantId, pi.tenantId); }).map(code);
      return sa.filter(function (a) {
        if (!a || !a.action) return false;
        var need = (Array.isArray(a.roles) ? a.roles : []).map(code);
        for (var i = 0; i < need.length; i++) if (need[i] === "*" || mine.indexOf(need[i]) !== -1) return true;
        return false;
      });
    }
    function fix(data) {
      if (!data || typeof data !== "object") return;
      var pis = Array.isArray(data.processInstances) ? data.processInstances : [];
      if (!pis.length) return;
      var roles = userRoles();
      if (!roles.length) return; // roles not loaded yet: leave as is
      var pi = latestPi(pis);
      if (!pi) return;
      var acts = allowedActions(pi, roles);
      var existing = Array.isArray(data.nextActions) ? data.nextActions : [];
      var out = acts.map(function (a) {
        for (var i = 0; i < existing.length; i++) if (existing[i] && existing[i].action === a.action) return existing[i];
        return shape(a);
      });
      var same = out.length === existing.length && out.every(function (x, i) { return x === existing[i]; });
      if (!same) data.nextActions = out;
    }
    function install() {
      if (!window.Digit || !Digit.Hooks || !Digit.Hooks.useWorkflowDetails) return false;
      if (!Digit.Hooks.__pgrWfDetailsV71 || !Digit.Hooks.__pgrCitizenRateV83) return false;
      if (Digit.Hooks.__pgrEmpTakeActionV85) return true;
      Digit.Hooks.__pgrEmpTakeActionV85 = true;
      var prev = Digit.Hooks.useWorkflowDetails;
      Digit.Hooks.useWorkflowDetails = function (params) {
        var result = prev.apply(this, arguments);
        try {
          if (result && result.data && params && params.moduleCode === "PGR" && onDetails()) fix(result.data);
        } catch (e) {}
        return result;
      };
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v85 employee PGR complaint details (END) ===== */
/* ===== UPYOG v86 employee PGR complaint details: REASSIGN popup assigneeRoles = roles at REASSIGN's target state (stock behaviour) (BEGIN) ===== */
(function () {
  try {
    var PATH_RE = /^\/digit-ui\/employee\/pgr\/complaint\/details\/[^\/]+/;
    var FALLBACK = ["GRO", "DGRO"];
    var bsStates = null, bsLoading = false;
    function onDetails() {
      try { return PATH_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function code(r) { return r && typeof r === "object" ? r.code : r; }
    function rolesOfState(st) {
      var out = [];
      var acts = (st && Array.isArray(st.actions)) ? st.actions : [];
      acts.forEach(function (a) {
        (a && Array.isArray(a.roles) ? a.roles : []).map(code).forEach(function (r) {
          if (r && out.indexOf(r) === -1) out.push(r);
        });
      });
      return out;
    }
    function loadBs() {
      if (bsStates || bsLoading) return;
      bsLoading = true;
      try {
        var u = Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser();
        var tok = u && (u.access_token || u.token);
        if (!tok || typeof fetch !== "function") { bsLoading = false; return; }
        var stateTid = String((Digit.ULBService && Digit.ULBService.getStateId && Digit.ULBService.getStateId()) || "pg").split(".")[0] || "pg";
        fetch("/egov-workflow-v2/egov-wf/businessservice/_search?tenantId=" + encodeURIComponent(stateTid) + "&businessServices=PGR", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ RequestInfo: { apiId: "Rainmaker", authToken: tok, userInfo: u.info, msgId: "pgr-wf-bs-v86" } })
        }).then(function (r) { return r.json(); }).then(function (res) {
          var st = (((res || {}).BusinessServices || [])[0] || {}).states;
          if (Array.isArray(st) && st.length) bsStates = st;
          bsLoading = false;
        }).catch(function () { bsLoading = false; });
      } catch (e) { bsLoading = false; }
    }
    function targetRoles(data, nextState) {
      if (!nextState) return FALLBACK.slice();
      var pis = Array.isArray(data.processInstances) ? data.processInstances : [];
      for (var i = 0; i < pis.length; i++) {
        var st = pis[i] && pis[i].state;
        if (st && st.uuid === nextState && Array.isArray(st.actions) && st.actions.length) {
          var r1 = rolesOfState(st); if (r1.length) return r1;
        }
      }
      if (bsStates) {
        for (var j = 0; j < bsStates.length; j++) {
          if (bsStates[j] && bsStates[j].uuid === nextState) { var r2 = rolesOfState(bsStates[j]); if (r2.length) return r2; }
        }
      }
      return FALLBACK.slice();
    }
    function fixList(data, list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || typeof a !== "object" || a.action !== "REASSIGN") continue;
        var want = targetRoles(data, a.nextState);
        var have = Array.isArray(a.assigneeRoles) ? a.assigneeRoles.map(code) : [];
        if (JSON.stringify(have) === JSON.stringify(want)) continue;
        var b = Object.assign({}, a); b.assigneeRoles = want; // copy: never mutate an object shared with data.nextActions
        list[i] = b;
      }
    }
    function fix(data) {
      if (!data || typeof data !== "object") return;
      if (!Array.isArray(data.processInstances) || !data.processInstances.length) return;
      loadBs();
      if (data.initialActionState && data.initialActionState.nextActions !== data.nextActions) fixList(data, data.initialActionState.nextActions);
      if (data.actionState && data.actionState !== data.initialActionState && data.actionState.nextActions !== data.nextActions) fixList(data, data.actionState.nextActions);
    }
    function install() {
      if (!window.Digit || !Digit.Hooks || !Digit.Hooks.useWorkflowDetails) return false;
      if (!Digit.Hooks.__pgrWfDetailsV71 || !Digit.Hooks.__pgrCitizenRateV83 || !Digit.Hooks.__pgrEmpTakeActionV85) return false;
      if (Digit.Hooks.__pgrReassignRolesV86) return true;
      Digit.Hooks.__pgrReassignRolesV86 = true;
      var prev = Digit.Hooks.useWorkflowDetails;
      Digit.Hooks.useWorkflowDetails = function (params) {
        var result = prev.apply(this, arguments);
        try {
          if (result && result.data && params && params.moduleCode === "PGR" && onDetails()) fix(result.data);
        } catch (e) {}
        return result;
      };
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v86 employee PGR complaint details REASSIGN assigneeRoles (END) ===== */
/* ===== UPYOG v87 employee PGR complaint details: REASSIGN popup shows a "returned to GRO" note instead of the Employee Name dropdown (BEGIN) ===== */
(function () {
  try {
    var PATH_RE = /^\/digit-ui\/employee\/pgr\/complaint\/details\/[^\/]+/;
    var NOTE_KEY = "CS_PGR_REASSIGN_RETURN_TO_GRO_NOTE";
    var NOTE_EN = "This complaint will be returned to the GRO for reassignment.";
    var lastActs = null;   // data.nextActions of the PGR details page (read only, = Take Action menu order)
    var pending = null, seen = false, startedAt = 0, obs = null, styled = false;
    function onDetails() {
      try { return PATH_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function tr(key, fallback) {
      try {
        var i = window.i18next;
        var v = i && typeof i.t === "function" ? i.t(key) : null;
        return v && v !== key ? String(v) : fallback;
      } catch (e) { return fallback; }
    }
    function addStyle() {
      if (styled) return;
      try {
        var s = document.createElement("style");
        s.setAttribute("data-upyog", "v87");
        s.textContent = "[data-v87-hide]{display:none !important}" +
          "[data-v87-note]::before{content:attr(data-v87-note);display:block;margin:0 0 16px 0;padding:12px 16px;" +
          "background:#f3f6fa;border-left:4px solid #0b4b66;color:#0b0c0c;font-size:16px;line-height:1.4}";
        (document.head || document.documentElement).appendChild(s);
        styled = true;
      } catch (e) {}
    }
    function stop() {
      pending = null; seen = false;
      if (obs) { try { obs.disconnect(); } catch (e) {} obs = null; }
    }
    function setText(el, text) {
      if (!el || !text) return;
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { if (n.nodeValue !== text) n.nodeValue = text; return; } // keep React's own text node
      }
    }
    function apply() {
      if (pending !== "REASSIGN") return;
      if (!onDetails()) { stop(); return; }
      var m = document.querySelector(".popup-module");
      if (!m) { if (seen || Date.now() - startedAt > 5000) stop(); return; }
      var ta = m.querySelector(".popup-module-main textarea");
      var card = ta && ta.parentElement;
      var commentsLabel = ta && ta.previousElementSibling;
      if (!card || !commentsLabel) return; // not the stock action popup
      seen = true;
      addStyle();
      for (var c = card.firstElementChild; c && c !== commentsLabel; c = c.nextElementSibling) {
        if (!c.hasAttribute("data-v87-hide")) c.setAttribute("data-v87-hide", "1");
      }
      var note = tr(NOTE_KEY, NOTE_EN);
      if (card.getAttribute("data-v87-note") !== note) card.setAttribute("data-v87-note", note);
      var title = tr("CS_HEADER_REASSIGN_COMPLAINT", null);
      if (title) setText(m.querySelector(".header-wrap h1"), title);
      var btn = tr("CS_ACTION_REASSIGN", null);
      if (btn) setText(m.querySelector(".popup-module-action-bar .selector-button-primary h2"), btn);
    }
    function onClick(ev) {
      try {
        if (!onDetails()) return;
        var t = ev.target && ev.target.closest ? ev.target.closest(".menu-wrap > div") : null;
        if (!t) return;
        stop();
        var acts = Array.isArray(lastActs) ? lastActs : null;
        if (!acts) return;
        var idx = Array.prototype.indexOf.call(t.parentElement.children, t);
        var a = acts[idx];
        if (!a || a.action !== "REASSIGN") return;
        pending = "REASSIGN"; startedAt = Date.now();
        if (typeof MutationObserver === "function" && document.body) {
          obs = new MutationObserver(function () { try { apply(); } catch (e) {} });
          obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
        setTimeout(function () { try { apply(); } catch (e) {} }, 0);
      } catch (e) {}
    }
    function install() {
      if (!window.Digit || !Digit.Hooks || !Digit.Hooks.useWorkflowDetails) return false;
      if (!Digit.Hooks.__pgrWfDetailsV71 || !Digit.Hooks.__pgrCitizenRateV83 || !Digit.Hooks.__pgrEmpTakeActionV85 || !Digit.Hooks.__pgrReassignRolesV86) return false;
      if (Digit.Hooks.__pgrReassignPopupV87) return true;
      Digit.Hooks.__pgrReassignPopupV87 = true;
      var prev = Digit.Hooks.useWorkflowDetails;
      Digit.Hooks.useWorkflowDetails = function (params) {
        var result = prev.apply(this, arguments);
        try {
          if (result && result.data && params && params.moduleCode === "PGR" && onDetails() && Array.isArray(result.data.nextActions)) {
            lastActs = result.data.nextActions; // observe only, never modified
          }
        } catch (e) {}
        return result;
      };
      try { document.addEventListener("click", onClick, true); } catch (e) {}
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v87 employee PGR complaint details REASSIGN popup note (END) ===== */
/* ===== UPYOG v88 PGR employee inbox: workflow search carries userInfo; GRO/DGRO open on "Assigned to All" (BEGIN) ===== */
(function () {
  try {
    var INBOX_RE = /^\/digit-ui\/employee\/pgr\/inbox\/?$/;
    var CHOICE_KEY = "upyog.pgrInboxAssignChoice.v88"; // per tab session: "ME" | "ALL", written only on a user click
    function onInbox() {
      try { return INBOX_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function user() {
      try { return (Digit.UserService && Digit.UserService.getUser && Digit.UserService.getUser()) || null; } catch (e) { return null; }
    }
    // (2) The stock inbox calls /egov-wf/process/_search without RequestInfo.userInfo -> 400 NullPointerException.
    // Add the logged-in user's info to that one request type, only while on the PGR employee inbox.
    if (!window.__upyogPgrInboxXhrV88 && typeof XMLHttpRequest === "function" && XMLHttpRequest.prototype) {
      window.__upyogPgrInboxXhrV88 = true;
      var pOpen = XMLHttpRequest.prototype.open, pSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__v88Url = String(url || ""); } catch (e) {}
        return pOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        try {
          if (onInbox() && this.__v88Url && this.__v88Url.indexOf("/egov-workflow-v2/egov-wf/process/_search") !== -1 && typeof body === "string" && body) {
            var j = JSON.parse(body);
            var u = user();
            if (j && j.RequestInfo && !j.RequestInfo.userInfo && u && u.info) {
              j.RequestInfo.userInfo = u.info;
              arguments[0] = JSON.stringify(j);
            }
          }
        } catch (e) {}
        return pSend.apply(this, arguments);
      };
    }
    // (3) Default filter: GRO/DGRO open on "Assigned to All"; LMEs keep the stock "Assigned to Me".
    // A user's own click on either option is remembered for the rest of the tab session and re-applied on entry.
    function isGro() {
      try {
        var u = user(), roles = (u && u.info && u.info.roles) || [];
        var t = String((Digit.ULBService && Digit.ULBService.getCurrentTenantId && Digit.ULBService.getCurrentTenantId()) || "");
        for (var i = 0; i < roles.length; i++) {
          var r = roles[i] || {}, rt = String(r.tenantId || "");
          if ((r.code === "GRO" || r.code === "DGRO") && (!t || rt === t || rt === t.split(".")[0])) return true;
        }
      } catch (e) {}
      return false;
    }
    function radios() {
      var f = document.querySelector(".filter .filter-card");
      if (!f) return null;
      var inputs = f.querySelectorAll("input.radio-btn[type=radio]");
      return inputs.length === 2 ? inputs : null; // [0] Assigned to Me, [1] Assigned to All (stock order)
    }
    var programmatic = false, applying = false, lastPath = null, appliedFor = null, seenAt = 0;
    function wanted() {
      var c = null;
      try { c = sessionStorage.getItem(CHOICE_KEY); } catch (e) {}
      if (c === "ME" || c === "ALL") return c;
      return isGro() ? "ALL" : null;
    }
    function tryApply(entry) {
      if (!onInbox() || appliedFor === entry) return true;
      var w = wanted();
      if (!w || w === "ME") { appliedFor = entry; return true; } // stock default already is Assigned to Me
      var rs = radios();
      if (!rs) return false;
      if (!rs[1].checked) { programmatic = true; try { rs[1].click(); } finally { programmatic = false; } }
      appliedFor = entry;
      return true;
    }
    document.addEventListener("click", function (ev) {
      try {
        if (programmatic || !onInbox()) return;
        var rs = radios(); if (!rs) return;
        var t = ev.target, wrap0 = rs[0].parentElement && rs[0].parentElement.parentElement, wrap1 = rs[1].parentElement && rs[1].parentElement.parentElement;
        if (wrap0 && wrap0.contains(t)) sessionStorage.setItem(CHOICE_KEY, "ME");
        else if (wrap1 && wrap1.contains(t)) sessionStorage.setItem(CHOICE_KEY, "ALL");
      } catch (e) {}
    }, true);
    var entry = 0;
    setInterval(function () {
      try {
        var p = String(window.location.pathname || "");
        if (p !== lastPath) { lastPath = p; seenAt = 0; if (onInbox()) { entry++; applying = Date.now(); } }
        if (applying && onInbox()) {
          // wait ~1.5 s after the filter appears so the stock mount effect has set its own default first
          var rs = radios();
          if (rs && !seenAt) seenAt = Date.now();
          if (rs && Date.now() - seenAt >= 1500 && tryApply(entry)) applying = false;
          else if (Date.now() - applying > 20000) applying = false;
        } else if (!onInbox()) { applying = false; }
      } catch (e) {}
    }, 300);
  } catch (eOuter) {}
})();
/* ===== UPYOG v88 PGR employee inbox (END) ===== */
/* ===== UPYOG v89 PGR complaint timeline: one 'Complaint filed' on the citizen summary; dd/MM/yyyy dates on citizen summary + employee details (BEGIN) ===== */
/* Display-time only (no API/data writes). Outermost useWorkflowDetails wrapper; runs after v83/v85/v86/v87 and only on:
 *   /digit-ui/citizen/pgr/complaints/<id>        (dedupe + dates)
 *   /digit-ui/employee/pgr/complaint/details/<id> (dates)
 * The stock citizen TimeLine pushes a COMPLAINT_FILED row into data.timeline on every mount; the guarded push below keeps one.
 * Companion in-place v71 change (re-fetch on visit / revalidate) is marked "v89" inside the v71 wrapper. */
(function () {
  try {
    var CIT_RE = /^\/digit-ui\/citizen\/pgr\/complaints\/[^\/]+/;
    var EMP_RE = /^\/digit-ui\/employee\/pgr\/complaint\/details\/[^\/]+/;
    function path() { try { return String((window.location && window.location.pathname) || ""); } catch (e) { return ""; } }
    function isFiled(x) { return !!x && x.status === "COMPLAINT_FILED"; }
    function dedupe(tl) {
      var seen = false;
      for (var i = 0; i < tl.length; i++) {
        if (isFiled(tl[i])) { if (seen) { tl.splice(i, 1); i--; } else seen = true; }
      }
      if (tl.__pgrFiledGuardV89) return;
      var nativePush = Array.prototype.push;
      Object.defineProperty(tl, "push", { configurable: true, enumerable: false, writable: true, value: function () {
        for (var j = 0; j < arguments.length; j++) {
          var it = arguments[j];
          if (isFiled(it)) { var has = false; for (var k = 0; k < this.length; k++) if (isFiled(this[k])) { has = true; break; } if (has) continue; }
          nativePush.call(this, it);
        }
        return this.length;
      } });
      Object.defineProperty(tl, "__pgrFiledGuardV89", { configurable: true, enumerable: false, value: true });
    }
    function fmt(v) {
      if (typeof v === "number" && isFinite(v) && v > 0) {
        try { var s = Digit.DateUtils && Digit.DateUtils.ConvertEpochToDate && Digit.DateUtils.ConvertEpochToDate(v); if (s) return s; } catch (e) {}
      }
      return v;
    }
    function dates(tl) {
      for (var i = 0; i < tl.length; i++) {
        var a = tl[i] && tl[i].auditDetails;
        if (a && typeof a === "object") { a.created = fmt(a.created); a.lastModified = fmt(a.lastModified); }
      }
    }
    function install() {
      if (!window.Digit || !Digit.Hooks || !Digit.Hooks.useWorkflowDetails || !Digit.Hooks.__pgrWfDetailsV71) return false;
      if (Digit.Hooks.__pgrTimelineV89) return true;
      Digit.Hooks.__pgrTimelineV89 = true;
      var prev = Digit.Hooks.useWorkflowDetails;
      Digit.Hooks.useWorkflowDetails = function (params) {
        var result = prev.apply(this, arguments);
        try {
          var pth = path(), cit = CIT_RE.test(pth), emp = EMP_RE.test(pth);
          var tl = result && result.data && result.data.timeline;
          if ((cit || emp) && params && params.moduleCode === "PGR" && Array.isArray(tl)) {
            if (cit) dedupe(tl);
            dates(tl);
          }
        } catch (e) {}
        return result;
      };
      return true;
    }
    if (!install()) {
      var n = 0;
      var iv = setInterval(function () { n++; if (install() || n > 600) clearInterval(iv); }, 100);
    }
  } catch (eOuter) {}
})();
/* ===== UPYOG v89 PGR complaint timeline (END) ===== */
/* ===== UPYOG v90 PGR citizen My Complaints card: status pill + text top-right, View / Review-Rate / Reopen buttons (BEGIN) ===== */
/* v91: maroon theme colours (#a82227 / hover #8b1e2b); card body click no longer navigates - only the buttons do. */
/* Display-only, citizen list page ONLY: /digit-ui/citizen/pgr/complaints (exact). No API calls, no data writes, no hooks wrapped.
 * Stock card (div.card): header.card-sub-header, div.date-wrap, div.key-note-pair, div.status-highlight > p, #text(status).
 * The status-highlight div and the status text node are moved (not cloned) into an owned top-right box so React keeps
 * updating them in place (className / nodeValue). Status + id are read live from the card's React props (fiber, read-only).
 * View / Review-Rate / Reopen navigate via the router history (v91). Review/Rate + Reopen only for RESOLVED / REJECTED. */
(function () {
  try {
    var LIST_RE = /^\/digit-ui\/citizen\/pgr\/complaints\/?$/;
    var BASE = "/digit-ui/citizen/pgr";
    var ACT_STATES = { RESOLVED: 1, REJECTED: 1 };
    var obs = null, timer = null, styled = false;
    if (window.__pgrCitizenCardsV90) return;
    window.__pgrCitizenCardsV90 = true;
    function onList() {
      try { return LIST_RE.test(String((window.location && window.location.pathname) || "")); } catch (e) { return false; }
    }
    function tr(key, fallback) {
      try {
        var i = window.i18next;
        var v = i && typeof i.t === "function" ? i.t(key) : null;
        return v && v !== key ? String(v) : fallback;
      } catch (e) { return fallback; }
    }
    function isEn() {
      try {
        var l = (window.Digit && Digit.StoreData && Digit.StoreData.getCurrentLanguage && Digit.StoreData.getCurrentLanguage()) || "en_IN";
        return String(l).indexOf("en") === 0;
      } catch (e) { return true; }
    }
    function label(key, en) { return isEn() ? en : tr(key, en); }
    function addStyle() {
      if (styled) return;
      try {
        if (document.querySelector("style[data-upyog='v90']")) { styled = true; return; }
        var s = document.createElement("style");
        s.setAttribute("data-upyog", "v90");
        s.textContent =
          "[data-v90-card]{position:relative}" +
          "[data-v90-card] > .card-sub-header,[data-v90-card] > .date-wrap,[data-v90-card] > .key-note-pair{padding-right:var(--v90-pad,150px)}" +
          ".v90-status{position:absolute;top:16px;right:16px;display:flex;flex-direction:column;align-items:flex-end;text-align:right;max-width:45%;font-size:14px;line-height:1.3;color:#505a5f}" +
          ".v90-status > .status-highlight{margin:0 0 4px 0}" +
          ".v90-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}" +
          ".v90-btn{min-width:88px;height:36px;padding:0 14px;font-size:15px;font-weight:600;border-radius:4px;cursor:pointer;line-height:34px;font-family:inherit;" +
          "background:#fff;color:#a82227;border:1px solid #a82227}" +
          ".v90-btn:hover{background:#fbeaeb;color:#8b1e2b;border-color:#8b1e2b}" +
          ".v90-btn.v90-primary{background:#a82227;color:#fff}" +
          ".v90-btn.v90-primary:hover{background:#8b1e2b;color:#fff;border-color:#8b1e2b}" +
          "[data-v90-card]{cursor:default !important}" +
          ".v90-btn:focus{outline:2px solid #ffdd00;outline-offset:1px}";
        (document.head || document.documentElement).appendChild(s);
        styled = true;
      } catch (e) {}
    }
    function reactKey(node, prefix) {
      try { for (var k in node) if (k.indexOf(prefix) === 0) return k; } catch (e) {}
      return null;
    }
    function fiberOf(node) {
      var k = reactKey(node, "__reactFiber$") || reactKey(node, "__reactInternalInstance$");
      return k ? node[k] : null;
    }
    function domId(card) {
      try { var p = card.querySelector(".key-note-pair p"); return p ? String(p.textContent || "").trim() : ""; } catch (e) { return ""; }
    }
    // Stock Complaint component props {data, path} for this card, from the COMMITTED fiber (the node's cached fiber can be the
    // stale alternate after a re-render). Current = the candidate whose rendered Card children are the host's current props.children.
    function cardProps(card) {
      try {
        var f = fiberOf(card), n = 0, pf = null;
        while (f && n < 12) {
          var p = f.memoizedProps;
          if (p && p.data && typeof p.data === "object" && p.data.serviceRequestId) { pf = f; break; }
          f = f["return"]; n++;
        }
        if (!pf) return null;
        var pk = reactKey(card, "__reactProps$"), hp = pk ? card[pk] : null;
        var cands = [pf, pf.alternate], pick = null, id = domId(card);
        for (var i = 0; i < cands.length && !pick; i++) {
          var c = cands[i];
          if (c && hp && c.child && c.child.memoizedProps && c.child.memoizedProps.children === hp.children) pick = c;
        }
        if (!pick) {
          // fallback: only trust a candidate whose id matches the card's visible complaint number, and only if unambiguous
          var m = [];
          for (var j = 0; j < cands.length; j++) if (cands[j] && cands[j].memoizedProps && cands[j].memoizedProps.data && String(cands[j].memoizedProps.data.serviceRequestId) === id) m.push(cands[j]);
          if (m.length === 1 || (m.length === 2 && m[0].memoizedProps.data.applicationStatus === m[1].memoizedProps.data.applicationStatus)) pick = m[0];
        }
        if (!pick) return null;
        var d = pick.memoizedProps.data;
        if (id && String(d.serviceRequestId) !== id) return null;
        return { id: String(d.serviceRequestId), status: String(d.applicationStatus || ""), path: typeof pick.memoizedProps.path === "string" ? pick.memoizedProps.path : "" };
      } catch (e) {}
      return null;
    }
    function routerHistory(card) {
      try {
        var f = fiberOf(card), n = 0;
        while (f && n < 400) {
          var v = f.memoizedProps && f.memoizedProps.value;
          if (f.type && f.type._context && v && v.history && typeof v.history.push === "function") return v.history;
          f = f["return"]; n++;
        }
      } catch (e) {}
      return null;
    }
    function go(card, url) {
      try { var h = routerHistory(card); if (h) { h.push(url); return; } } catch (e) {}
      try { window.location.assign(url); } catch (e2) {}
    }
    function mkBtn(kind, text, primary) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "v90-btn" + (primary ? " v90-primary" : "");
      b.setAttribute("data-v90-btn", kind);
      b.textContent = text;
      return b;
    }
    function onBtn(ev) {
      try {
        var b = ev.currentTarget;
        var kind = b && b.getAttribute("data-v90-btn");
        ev.preventDefault(); ev.stopPropagation(); // v91: card onClick is blocked, every button navigates itself
        var card = b.closest ? b.closest("[data-v90-card]") : null;
        if (!card) return;
        var info = cardProps(card);
        var id = (info && info.id) || card.getAttribute("data-v90-id");
        if (!id) return;
        if (kind === "view") { go(card, ((info && info.path) || (BASE + "/complaints")) + "/" + id); return; } // = stock card target
        go(card, BASE + "/" + (kind === "rate" ? "rate" : "reopen") + "/" + id);
      } catch (e) {}
    }
    function buildActions(card, status) {
      var row = document.createElement("div");
      row.className = "v90-actions";
      row.setAttribute("data-v90-actions", status || "");
      var list = [mkBtn("view", label("CS_COMMON_VIEW", "View"), true)];
      if (ACT_STATES[status]) {
        list.push(mkBtn("rate", label("CS_COMMON_RATE", "Review/Rate"), false));
        list.push(mkBtn("reopen", label("CS_COMMON_REOPEN", "Reopen"), false));
      }
      for (var i = 0; i < list.length; i++) { list[i].addEventListener("click", onBtn); row.appendChild(list[i]); }
      return row;
    }
    function fixCard(card) {
      // locate the stock pill + status text (first pass: direct children; later passes: inside our box)
      var box = null, kids = card.children;
      for (var i = 0; i < kids.length; i++) if (kids[i].classList && kids[i].classList.contains("v90-status")) { box = kids[i]; break; }
      if (!box) {
        var pill = null;
        for (var j = 0; j < kids.length; j++) if (kids[j].classList && kids[j].classList.contains("status-highlight")) { pill = kids[j]; break; }
        if (!pill) return; // not the stock complaint card shape - leave it alone
        var txt = pill.nextSibling;
        box = document.createElement("div");
        box.className = "v90-status";
        card.insertBefore(box, card.firstChild);
        box.appendChild(pill);
        if (txt && txt.nodeType === 3) {
          var line = document.createElement("div");
          line.className = "v90-status-text";
          line.appendChild(txt);
          box.appendChild(line);
        }
        card.setAttribute("data-v90-card", "1");
        // v91: capture-phase guard on the card - clicks that are not on our buttons never reach the stock card onClick (list page only)
        if (!card.__v91ClickGuard) {
          card.__v91ClickGuard = true;
          card.addEventListener("click", function (ev) {
            try {
              if (!onList()) return;
              var t = ev.target;
              if (t && t.closest && t.closest("[data-v90-btn]")) return;
              ev.stopPropagation();
            } catch (e) {}
          }, true);
        }
        try { card.style.setProperty("--v90-pad", Math.min(Math.max(box.offsetWidth + 24, 110), 220) + "px"); } catch (eW) {}
      }
      var info = cardProps(card);
      var status = (info && info.status) || "";
      if (info && info.id && card.getAttribute("data-v90-id") !== info.id) card.setAttribute("data-v90-id", info.id);
      var row = null;
      for (var r = 0; r < card.children.length; r++) if (card.children[r].classList && card.children[r].classList.contains("v90-actions")) { row = card.children[r]; break; }
      if (row && row.getAttribute("data-v90-actions") === status && row.getAttribute("data-v90-en") === String(isEn())) return;
      var nr = buildActions(card, status);
      nr.setAttribute("data-v90-en", String(isEn()));
      if (row) card.replaceChild(nr, row); else card.appendChild(nr);
    }
    function apply() {
      timer = null;
      if (!onList()) return;
      addStyle();
      var root = document.querySelector(".applications-list-container");
      if (!root) return;
      var cards = root.querySelectorAll(".card, .employeeCard");
      for (var i = 0; i < cards.length; i++) { try { fixCard(cards[i]); } catch (e) {} }
    }
    function schedule() { if (!timer) timer = setTimeout(function () { try { apply(); } catch (e) {} }, 30); }
    function tick() {
      try {
        if (onList()) {
          if (!obs && typeof MutationObserver === "function" && document.body) {
            obs = new MutationObserver(function () { if (onList()) schedule(); });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
          }
          schedule();
        } else if (obs) { obs.disconnect(); obs = null; }
      } catch (e) {}
    }
    setInterval(tick, 400);
    tick();
  } catch (eOuter) {}
})();
/* ===== UPYOG v90 PGR citizen My Complaints card (END) ===== */
/* ===== UPYOG v91 citizen complaint details: hide Rate / Reopen links in the Complaint Timeline (BEGIN) ===== */
/* CSS-only hide, active only while the path is /digit-ui/citizen/pgr/complaints/<id> (html[data-v91-citdet]).
 * No data is changed: v83 still fills timeLineActions, v89 dedupe/dates untouched, /rate and /reopen routes keep working. */
(function () {
  try {
    if (window.__pgrCitDetLinksV91) return;
    window.__pgrCitDetLinksV91 = true;
    var RE = /^\/digit-ui\/citizen\/pgr\/complaints\/[^\/]+/;
    function sync() {
      try {
        var on = RE.test(String((window.location && window.location.pathname) || ""));
        var h = document.documentElement;
        if (!h) return;
        if (on && !h.hasAttribute("data-v91-citdet")) h.setAttribute("data-v91-citdet", "1");
        else if (!on && h.hasAttribute("data-v91-citdet")) h.removeAttribute("data-v91-citdet");
        if (!document.querySelector("style[data-upyog='v91']") && (document.head || h)) {
          var s = document.createElement("style");
          s.setAttribute("data-upyog", "v91");
          s.textContent = "html[data-v91-citdet] a[href*='/citizen/pgr/rate/'],html[data-v91-citdet] a[href*='/citizen/pgr/reopen/']{display:none !important}";
          (document.head || h).appendChild(s);
        }
      } catch (e) {}
    }
    sync();
    setInterval(sync, 150);
    try { window.addEventListener("popstate", sync); } catch (e) {}
  } catch (eOuter) {}
})();
/* ===== UPYOG v91 citizen complaint details (END) ===== */
/* ===== UPYOG v92 Karjat logo in the header tenant slot, pg.karjat only (BEGIN) ===== */
/* Additive, display-only. Citizen header: .navbar .hambuger-back-wrapper > h3 (tenant text after the divider).
 * Employee header: .topbar p.ulb (tenant name). Shown only when BOTH the app tenant is pg.karjat AND the slot text
 * names Karjat; otherwise the stock text stays. The text element is only hidden via a data attribute (never removed),
 * the logo is a sibling <img> we own. Logo = Jennifer's Karjat.jpg as-is (501x209 JPEG, data URI), sized by height. */
(function () {
  try {
    if (window.__upyogKarjatLogoV92) return;
    window.__upyogKarjatLogoV92 = true;
    var SRC = "data:image/jpeg;base64,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";
    var TENANT = "pg.karjat";
    var CLS = "v92-karjat-logo";
    function lc(s) { return String(s || "").toLowerCase(); }
    function namesKarjat(el) {
      var t = lc(el && el.textContent);
      return t.indexOf("karjat") !== -1 || t.indexOf("\u0915\u0930\u094d\u091c\u0924") !== -1; // "कर्जत"
    }
    function citizenTenant() {
      try {
        var a = window.Digit && Digit.ULBService && Digit.ULBService.getCitizenCurrentTenant && Digit.ULBService.getCitizenCurrentTenant(true);
        if (a) return String(a);
        var c = window.Digit && Digit.SessionStorage && Digit.SessionStorage.get && Digit.SessionStorage.get("CITIZEN.COMMON.HOME.CITY");
        return c && c.code ? String(c.code) : "";
      } catch (e) { return ""; }
    }
    function employeeTenant() {
      try { return String((window.Digit && Digit.ULBService && Digit.ULBService.getCurrentTenantId && Digit.ULBService.getCurrentTenantId()) || ""); } catch (e) { return ""; }
    }
    var styled = false;
    function addStyle() {
      if (styled) return;
      if (document.querySelector("style[data-upyog='v92']")) { styled = true; return; }
      var s = document.createElement("style");
      s.setAttribute("data-upyog", "v92");
      s.textContent =
        "[data-v92-hide]{display:none !important}" +
        "img." + CLS + "{display:inline-block;width:auto !important;min-width:0 !important;max-width:none;object-fit:contain;vertical-align:middle;align-self:center;flex-shrink:0}" +
        ".navbar img." + CLS + "{height:50px !important;margin:-13px 0 -13px 8px;padding-left:8px;border-left:1px solid #fff;box-sizing:content-box}" +
        ".topbar img." + CLS + "{height:52px !important;margin:-2px 8px -2px 0}" +
        "@media (max-width:660px){.navbar img." + CLS + "{height:36px !important;margin-top:-6px;margin-bottom:-6px}.topbar img." + CLS + "{height:36px !important;margin-top:0;margin-bottom:0}}";
      (document.head || document.documentElement).appendChild(s);
      styled = true;
    }
    function mine(slot) {
      var n = slot.nextElementSibling;
      return n && n.classList && n.classList.contains(CLS) ? n : null;
    }
    function syncSlot(slot, on) {
      var img = mine(slot);
      if (on) {
        addStyle();
        if (!img) {
          img = document.createElement("img");
          img.className = CLS;
          img.src = SRC;
          img.alt = "Karjat Nagar Parishad";
          img.decoding = "async";
          slot.insertAdjacentElement("afterend", img);
        }
        if (!slot.hasAttribute("data-v92-hide")) slot.setAttribute("data-v92-hide", "1");
      } else {
        if (img && img.parentNode) img.parentNode.removeChild(img);
        if (slot.hasAttribute("data-v92-hide")) slot.removeAttribute("data-v92-hide");
      }
    }
    function sync() {
      try {
        var cit = document.querySelectorAll(".navbar .hambuger-back-wrapper > h3");
        if (cit.length) { var ct = citizenTenant(); for (var i = 0; i < cit.length; i++) syncSlot(cit[i], ct === TENANT && namesKarjat(cit[i])); }
        var emp = document.querySelectorAll(".topbar p.ulb");
        if (emp.length) { var et = employeeTenant(); for (var j = 0; j < emp.length; j++) syncSlot(emp[j], et === TENANT && namesKarjat(emp[j])); }
        // stray logo whose slot vanished (slot re-created by React): drop it
        var imgs = document.querySelectorAll("img." + CLS);
        for (var k = 0; k < imgs.length; k++) { var p = imgs[k].previousElementSibling; if (!p || !p.hasAttribute("data-v92-hide")) imgs[k].parentNode.removeChild(imgs[k]); }
      } catch (e) {}
    }
    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      var run = function () { queued = false; sync(); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 16);
    }
    function start() {
      sync();
      try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}
      setInterval(sync, 1000); // tenant switch without DOM change (storage only)
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  } catch (eOuter) {}
})();
/* ===== UPYOG v92 Karjat logo (END) ===== */
