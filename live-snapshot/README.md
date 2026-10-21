# live-snapshot (reference only)

Byte-exact snapshot of the hand-applied UI / proxy ConfigMaps running on the enagariseva.com
UPYOG cluster (EKS `upyog-eks-001`, ap-south-1, namespace `egov`), taken 2026-10-19 (IST).

**This folder is a reference snapshot. It is NOT wired into helm or the deployer**; nothing here is
applied automatically. Live is patched directly via ConfigMaps (`pgr-inbox-patch` is at v93).

Files under `configmaps/<configmap-name>/<key>` are exported with `kubectl get cm -o jsonpath`
(redirected to file, no re-encoding); the PNG is decoded from `binaryData`. `.gitattributes`
marks this folder `-text` so git stores the bytes unchanged. Verify with `sha256sum`.

| File | Bytes | sha256 |
|---|---|---|
| `configmaps/digit-ui-branding/enagariseva-logo.js` | 2146 | `28055aef1d60b8c89a17052810070f865c5c61f7372f7e8059cf7f445120b709` |
| `configmaps/digit-ui-branding/enagariseva-logo.png` | 193930 | `d16a0b173af9db0ac82be3bb61e0175c9e29b09a0ca4b4be488c958fcee1869f` |
| `configmaps/digit-ui-js-injection/default.conf` | 586 | `4a4634329638c5f446f28aba2d7b8a1189dbe8bba2fc36d07bc14daa1a9ef0de` |
| `configmaps/digit-ui-js-injection/sub_filter.conf` | 298 | `fff3f903d74bf118c42b6e93c5e9515ba6f672dad8a836a39f1983e61feaab5f` |
| `configmaps/digit-ui-mutation-fix/mutation-error-fix.js` | 7151 | `130d371c13be739c4a6c26debcb3e9596444dc6c9b35c5c7ce699fde328a4681` |
| `configmaps/digit-ui-pt-error-patch/pt-error-patch.js` | 4617 | `2fa5ed64b20e2dd2e698f91edd4a1e0eb53a32470fbd631a6b012d84f05156b3` |
| `configmaps/digit-ui-pt-take-action/pt-take-action.js` | 31885 | `b26cd8c7207be72354417f79ca40abf0301a95b34cd7207a993fecbc6b061761` |
| `configmaps/pgr-inbox-patch/pgr-inbox-patch.js` | 320825 | `5dfd2ccf7476ec1ff8e06c30aa2df8724ae05b317f326346d2f4d93fb60a2d92` |
| `configmaps/pgr-persister-fix/pgr-services-persister.yml` | 5090 | `4256933e1d2ffceac337851e885a35a96219631c50d68644e746176b9ba89d3f` |
| `configmaps/razorpay-proxy/razorpay-proxy.py` | 8220 | `37bfea2f6819f3caba94b8d8da8461b51f0144958ab56b5d623cf69eec1d5a87` |
| `configmaps/sms-dlt-proxy/sms-dlt-proxy.py` | 3174 | `a6c9fd197452cc41bdb15abd0ca07dd33fac648361029234220dcd25b8dc0471` |

`deployments/` holds sanitized exports of `digit-ui` (7 ConfigMap mounts + razorpay-proxy sidecar),
`egov-notification-sms` (sms-dlt-proxy sidecar) and `egov-persister` (`/config` from `pgr-persister-fix`).
Status, managedFields and last-applied annotations are removed; `secretKeyRef` entries are kept only as
references (no values), and any plain env value with a secret-like name is replaced by `<REDACTED:NAME>`.
