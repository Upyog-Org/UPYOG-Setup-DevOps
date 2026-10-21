#!/usr/bin/env python3
"""Local sidecar: replace hardcoded SMS key, rewrite OTP text to DLT template, return API000."""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

INSTA_URL = os.environ.get(
    "INSTA_URL", "https://japi.instaalerts.zone/httpapi/QueryStringReceiver"
)
INSTA_KEY = os.environ.get("INSTA_KEY", "")
PORT = int(os.environ.get("PORT", "8090"))

OTP_RE = re.compile(
    r"(?:Your (?:Login )?OTP(?: to complete your mSeva Registration)? is|"
    r"OTP to complete your mSeva Registration is|Login OTP is|OTP is)\s+(\d{4,8})",
    re.I,
)
DLT = (
    "OTP ForAMC LOGIN is {otp} for Mobile No {mobile}. "
    "Please do not share OTP with anyone. Regards,AMC ASCULB"
)


def last10(dest):
    digits = re.sub(r"\D", "", dest or "")
    return digits[-10:] if len(digits) >= 10 else digits


def rewrite_text(text, dest):
    if not text:
        return text, False
    match = OTP_RE.search(text)
    if not match:
        return text, False
    return DLT.format(otp=match.group(1), mobile=last10(dest)), True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("proxy %s\n" % (fmt % args))

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        params = {k: (v[0] if v else "") for k, v in query.items()}
        dest = params.get("dest", "")
        text = params.get("text", "")
        new_text, is_otp = rewrite_text(text, dest)
        body = b"code=API000 & info=Sms platform accepted"
        code = 200
        if not is_otp:
            print("skip_nondlt dest", dest, "chars", len(text or ""), flush=True)
        else:
            params["key"] = INSTA_KEY
            params["text"] = new_text
            url = INSTA_URL + "?" + urlencode(params, quote_via=quote)
            try:
                req = Request(url, method="GET")
                with urlopen(req, timeout=20) as resp:
                    up = resp.read()[:180]
                    print("upstream", resp.status, "dest", dest, "otp_rewritten", True, "body", up, flush=True)
            except HTTPError as exc:
                err = exc.read()[:180]
                print("upstream_http", exc.code, err, flush=True)
            except (URLError, OSError) as exc:
                print("upstream_err", type(exc).__name__, exc, flush=True)
                code = 502
                body = b"code=API001 & info=proxy_error"
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not INSTA_KEY:
        print("INSTA_KEY missing", flush=True)
        raise SystemExit(1)
    print("sms-dlt-proxy listen 127.0.0.1:%s" % PORT, flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
