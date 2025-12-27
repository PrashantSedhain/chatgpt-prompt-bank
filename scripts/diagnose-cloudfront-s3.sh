#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Diagnose CloudFront + private S3 static site setup (OAC/OAI).

Usage:
  scripts/diagnose-cloudfront-s3.sh --bucket <bucket> --distribution-id <id> [--region us-east-1] [--profile prashant]

Examples:
  scripts/diagnose-cloudfront-s3.sh --bucket prompt-bank-ui-build --distribution-id E3RBP1VPS294EN --profile prashant

What this checks:
  - CloudFront origin domain (bucket REST endpoint vs s3-website endpoint)
  - Whether an Origin Access Control (OAC) is attached
  - Default root object and custom error responses
  - S3 Block Public Access status
  - S3 bucket policy allows CloudFront to read objects (arn:aws:s3:::bucket/*)
  - Presence of index.html and error.html objects
USAGE
}

bucket=""
distribution_id=""
region="us-east-1"
profile="prashant"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) bucket="${2:-}"; shift 2 ;;
    --distribution-id|--dist|--distribution) distribution_id="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --profile) profile="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$bucket" || -z "$distribution_id" ]]; then
  echo "Missing required args." >&2
  usage
  exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found. Install AWS CLI v2 first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found (needed for JSON parsing). Install python3 or modify the script to use jq." >&2
  exit 1
fi

AWS=(aws --profile "$profile" --region "$region")

say() { printf "\n== %s ==\n" "$1"; }
ok() { printf "[OK] %s\n" "$1"; }
warn() { printf "[WARN] %s\n" "$1"; }
bad() { printf "[ERROR] %s\n" "$1"; }

json_get() {
  # Usage: json_get '<python-expr that prints>' <json_file>
  python3 - "$@" <<'PY'
import json, sys
expr = sys.argv[1]
path = sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
  data = json.load(f)
globals_dict = {"data": data}
exec(expr, globals_dict, globals_dict)
PY
}

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

say "Inputs"
echo "Bucket:          $bucket"
echo "Distribution ID: $distribution_id"
echo "Region:          $region"
echo "Profile:         $profile"

say "CloudFront distribution config"
dist_cfg_json="$tmpdir/dist-config.json"
dist_json="$tmpdir/dist.json"

${AWS[@]} cloudfront get-distribution-config --id "$distribution_id" >"$dist_cfg_json"
${AWS[@]} cloudfront get-distribution --id "$distribution_id" >"$dist_json"

dist_domain="$(python3 -c 'import json;print(json.load(open("'"$dist_json"'"))["Distribution"]["DomainName"])')"
echo "Distribution domain: $dist_domain"

default_root="$(python3 -c 'import json;print(json.load(open("'"$dist_cfg_json"'"))["DistributionConfig"].get("DefaultRootObject",""))')"
if [[ -z "$default_root" ]]; then
  bad "DefaultRootObject is not set. For static sites, set it to index.html (CloudFront → Settings → Default root object)."
else
  ok "DefaultRootObject: $default_root"
fi

python3 - <<'PY' "$dist_cfg_json"
import json, sys
cfg = json.load(open(sys.argv[1]))["DistributionConfig"]
origins = cfg.get("Origins", {}).get("Items", [])
default = cfg.get("DefaultCacheBehavior", {})
print("\nOrigins:")
for o in origins:
  dom = o.get("DomainName","")
  oid = o.get("Id","")
  oac = o.get("OriginAccessControlId","")
  print(f" - {oid}: {dom}  OAC={'yes' if oac else 'no'}")
print("\nDefaultCacheBehavior.TargetOriginId:", default.get("TargetOriginId",""))
errs = cfg.get("CustomErrorResponses", {}).get("Items", [])
print("\nCustomErrorResponses:")
if not errs:
  print(" - (none)")
for e in errs:
  print(f" - {e.get('ErrorCode')} -> {e.get('ResponsePagePath','')} (resp {e.get('ResponseCode','')})")
PY

say "Origin endpoint sanity"
target_origin_id="$(python3 -c 'import json;cfg=json.load(open("'"$dist_cfg_json"'"))["DistributionConfig"];print(cfg.get("DefaultCacheBehavior",{}).get("TargetOriginId",""))')"
origin_domain="$(python3 - <<'PY' "$dist_cfg_json" "$target_origin_id"
import json, sys
cfg = json.load(open(sys.argv[1]))["DistributionConfig"]
target = sys.argv[2]
for o in cfg.get("Origins", {}).get("Items", []):
  if o.get("Id") == target:
    print(o.get("DomainName",""))
    raise SystemExit(0)
print("")
PY
)"

oac_id="$(python3 - <<'PY' "$dist_cfg_json" "$target_origin_id"
import json, sys
cfg = json.load(open(sys.argv[1]))["DistributionConfig"]
target = sys.argv[2]
for o in cfg.get("Origins", {}).get("Items", []):
  if o.get("Id") == target:
    print(o.get("OriginAccessControlId",""))
    raise SystemExit(0)
print("")
PY
)"

if [[ -z "$origin_domain" ]]; then
  bad "Could not find origin domain for DefaultCacheBehavior.TargetOriginId=$target_origin_id"
else
  echo "Origin domain for default behavior: $origin_domain"
  if [[ "$origin_domain" == *"s3-website-"* ]]; then
    bad "Origin is an S3 website endpoint. Private bucket + OAC/OAI will NOT work. Use the S3 REST endpoint: ${bucket}.s3.${region}.amazonaws.com"
  else
    ok "Origin is not an S3 website endpoint."
  fi
fi

if [[ -z "$oac_id" ]]; then
  warn "No OriginAccessControlId on the default origin. If your bucket is private, you must attach OAC (recommended) or legacy OAI."
else
  ok "OriginAccessControlId: $oac_id"
  say "OAC details"
  ${AWS[@]} cloudfront get-origin-access-control --id "$oac_id" >"$tmpdir/oac.json"
  python3 - <<'PY' "$tmpdir/oac.json"
import json, sys
o = json.load(open(sys.argv[1]))["OriginAccessControl"]["OriginAccessControlConfig"]
print("Name:", o.get("Name",""))
print("OriginType:", o.get("OriginAccessControlOriginType",""))
print("SigningBehavior:", o.get("SigningBehavior",""))
print("SigningProtocol:", o.get("SigningProtocol",""))
PY
fi

say "S3 object presence"
for key in index.html error.html; do
  if ${AWS[@]} s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>&1; then
    ok "Found s3://$bucket/$key"
  else
    bad "Missing s3://$bucket/$key (or access denied to list it). Ensure it's uploaded to the bucket root."
  fi
done

say "S3 Block Public Access"
if ${AWS[@]} s3api get-public-access-block --bucket "$bucket" >"$tmpdir/pab.json" 2>/dev/null; then
  python3 - <<'PY' "$tmpdir/pab.json"
import json, sys
cfg = json.load(open(sys.argv[1]))["PublicAccessBlockConfiguration"]
print(cfg)
PY
  ok "Fetched PublicAccessBlockConfiguration."
else
  warn "Could not read PublicAccessBlockConfiguration (missing permissions?)."
fi

say "S3 bucket policy (CloudFront read)"
if ${AWS[@]} s3api get-bucket-policy --bucket "$bucket" >"$tmpdir/policy.json" 2>/dev/null; then
  policy_check_out="$tmpdir/policy-check.txt"
  python3 - <<'PY' "$tmpdir/policy.json" "$bucket" "$distribution_id" >"$policy_check_out"
import json, sys
doc = json.loads(json.load(open(sys.argv[1]))["Policy"])
bucket = sys.argv[2]
dist = sys.argv[3]
want_source_arn_suffix = f":distribution/{dist}"
want_resource = f"arn:aws:s3:::{bucket}/*"

stmts = doc.get("Statement", [])
if isinstance(stmts, dict):
  stmts = [stmts]

hits = []
for s in stmts:
  if s.get("Effect") != "Allow":
    continue
  action = s.get("Action")
  actions = action if isinstance(action, list) else [action]
  if "s3:GetObject" not in actions:
    continue
  princ = s.get("Principal", {})
  svc = None
  if isinstance(princ, dict):
    svc = princ.get("Service")
  res = s.get("Resource")
  resources = res if isinstance(res, list) else [res]
  cond = s.get("Condition", {}).get("StringEquals", {})
  src = cond.get("AWS:SourceArn")
  if svc == "cloudfront.amazonaws.com":
    hits.append((resources, src))

if not hits:
  print("NO_MATCH")
  raise SystemExit(0)

print("MATCHES:")
for resources, src in hits:
  print(" Resource:", resources)
  print(" SourceArn:", src)

bad = False
for resources, src in hits:
  if want_resource not in resources:
    bad = True
  if not (isinstance(src, str) and src.endswith(want_source_arn_suffix)):
    bad = True
print("OK" if not bad else "BAD")
PY
  cat "$policy_check_out"
  policy_status="$(tail -n 1 "$policy_check_out")"
  if [[ "$policy_status" == "OK" ]]; then
    ok "Bucket policy contains a matching Allow for CloudFront + correct Resource/SourceArn."
  elif [[ "$policy_status" == "NO_MATCH" ]]; then
    bad "Bucket policy does not contain an Allow for Principal cloudfront.amazonaws.com with Action s3:GetObject."
  else
    bad "Bucket policy has a CloudFront Allow but Resource/SourceArn do not match what CloudFront needs."
    echo "Expected Resource: arn:aws:s3:::${bucket}/*"
    echo "Expected SourceArn: arn:aws:cloudfront::559118953851:distribution/${distribution_id}"
  fi
else
  warn "No bucket policy found (or access denied). For private buckets with OAC, you must add a policy allowing cloudfront.amazonaws.com s3:GetObject on arn:aws:s3:::$bucket/* with AWS:SourceArn = your distribution ARN."
fi

say "Recommended next steps (most common causes of 403)"
cat <<EOF
- Ensure CloudFront origin domain is the S3 REST endpoint: ${bucket}.s3.${region}.amazonaws.com (not s3-website-...)
- Ensure OAC is attached to the origin (OriginAccessControlId present) and bucket policy allows s3:GetObject on arn:aws:s3:::${bucket}/*
- Ensure CloudFront "Default root object" is set to index.html
- Ensure custom error response uses /error.html (leading slash) and invalidate /* after changes
EOF

say "Test URLs"
echo "Try:"
echo "  https://${dist_domain}/index.html"
echo "  https://${dist_domain}/error.html"
echo "  https://${dist_domain}/"
