#!/usr/bin/env python3
"""Local sidecar: Razorpay order + verify, then collection-services payment create."""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
COLLECTION_HOST = os.environ.get(
    "COLLECTION_HOST", "http://collection-services:8080"
).rstrip("/")
PORT = int(os.environ.get("PORT", "8091"))
MERCHANT_NAME = os.environ.get("MERCHANT_NAME", "eNagariseva")
ORDERS = {}
PAID = set()


def auth_header():
    token = base64.b64encode(("%s:%s" % (KEY_ID, KEY_SECRET)).encode()).decode()
    return "Basic " + token


def http_json(method, url, body=None, headers=None, timeout=25):
    data = None if body is None else json.dumps(body).encode()
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw[:500]}
        return e.code, parsed
    except (URLError, OSError) as e:
        return 502, {"error": type(e).__name__, "detail": str(e)}


def paise(amount):
    try:
        return int(round(float(amount) * 100))
    except Exception:
        return 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("rzp %s\n" % (fmt % args))

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode() or "{}")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/", ""):
            self._send(200, {"status": "UP", "gateway": "RAZORPAY"})
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/order":
            self.handle_order()
            return
        if path == "/verify":
            self.handle_verify()
            return
        self._send(404, {"error": "not_found"})

    def handle_order(self):
        payload = self._read_json()
        txn = payload.get("Transaction") or {}
        ri = payload.get("RequestInfo") or payload.get("requestInfo") or {}
        amount = txn.get("txnAmount")
        taps = txn.get("taxAndPayments") or []
        if amount is None and taps:
            amount = (taps[0] or {}).get("amountPaid")
        amt = paise(amount)
        if amt <= 0:
            self._send(400, {"error": "invalid_amount"})
            return
        receipt = str(txn.get("consumerCode") or txn.get("billId") or "pt")[:40]
        status, body = http_json(
            "POST",
            "https://api.razorpay.com/v1/orders",
            {
                "amount": amt,
                "currency": "INR",
                "receipt": receipt,
                "payment_capture": 1,
            },
            {"Authorization": auth_header()},
        )
        if status >= 300 or not body.get("id"):
            print("order_fail", status, body, flush=True)
            self._send(502, {"error": "order_failed"})
            return
        order_id = body["id"]
        ORDERS[order_id] = {"txn": txn, "requestInfo": ri, "amount": amount, "paise": amt}
        print("order_ok", order_id, "amt", amt, flush=True)
        user = txn.get("user") or {}
        self._send(
            200,
            {
                "key": KEY_ID,
                "order_id": order_id,
                "amount": amt,
                "currency": "INR",
                "name": MERCHANT_NAME,
                "description": txn.get("module") or "Property Tax",
                "prefill": {
                    "name": user.get("name") or "",
                    "contact": user.get("mobileNumber") or "",
                    "email": user.get("emailId") or "",
                },
                "callbackUrl": txn.get("callbackUrl") or "",
            },
        )

    def handle_verify(self):
        payload = self._read_json()
        order_id = payload.get("razorpay_order_id") or ""
        payment_id = payload.get("razorpay_payment_id") or ""
        signature = payload.get("razorpay_signature") or ""
        expected = hmac.new(
            KEY_SECRET.encode(),
            ("%s|%s" % (order_id, payment_id)).encode(),
            hashlib.sha256,
        ).hexdigest()
        if not order_id or not payment_id or not hmac.compare_digest(expected, signature):
            print("bad_sig", bool(order_id), bool(payment_id), flush=True)
            self._send(400, {"error": "signature_failed"})
            return
        ctx = ORDERS.get(order_id) or {
            "txn": payload.get("Transaction") or {},
            "requestInfo": payload.get("RequestInfo") or {},
            "amount": None,
        }
        txn = ctx.get("txn") or {}
        if payment_id in PAID:
            self._send(
                200,
                {"ok": True, "duplicate": True, "callbackUrl": txn.get("callbackUrl") or ""},
            )
            return
        ri = ctx.get("requestInfo") or payload.get("RequestInfo") or {}
        amount = ctx.get("amount")
        if amount is None:
            amount = txn.get("txnAmount")
        taps = txn.get("taxAndPayments") or [{}]
        bill_id = (taps[0] or {}).get("billId") or txn.get("billId")
        tenant = txn.get("tenantId") or "pg.citya"
        user = txn.get("user") or {}
        paid_amt = float(amount)
        payment = {
            "tenantId": tenant,
            "paymentMode": "ONLINE",
            "paidBy": user.get("name") or "Citizen",
            "mobileNumber": user.get("mobileNumber") or "",
            "payerName": user.get("name") or "Citizen",
            "totalAmountPaid": paid_amt,
            "instrumentDate": int(time.time() * 1000),
            "instrumentNumber": payment_id,
            "transactionNumber": payment_id,
            "paymentDetails": [
                {
                    "tenantId": tenant,
                    "businessService": txn.get("module") or "PT",
                    "billId": bill_id,
                    "totalAmountPaid": paid_amt,
                }
            ],
        }
        status, body = http_json(
            "POST",
            COLLECTION_HOST + "/collection-services/payments/_create",
            {"RequestInfo": ri, "Payment": payment},
        )
        if status >= 300:
            print("collection_fail", status, body, flush=True)
            self._send(502, {"error": "collection_failed", "detail": body})
            return
        PAID.add(payment_id)
        print("paid", payment_id, "bill", bill_id, flush=True)
        self._send(
            200,
            {
                "ok": True,
                "callbackUrl": txn.get("callbackUrl") or "",
                "Payments": body.get("Payments") or body.get("payments"),
            },
        )


if __name__ == "__main__":
    if not KEY_ID or not KEY_SECRET:
        print("missing RAZORPAY_KEY_ID/SECRET", flush=True)
        sys.exit(1)
    print("razorpay-proxy listen 127.0.0.1:%s" % PORT, flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
