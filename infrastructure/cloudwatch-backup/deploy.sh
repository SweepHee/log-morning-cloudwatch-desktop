#!/usr/bin/env bash
set -euo pipefail

# Log Morning 공개용 CloudWatch 백업 스택 배포 도구.
# 이 스택은 운영 서비스 요청을 처리하지 않는다. 필요 없으면 CloudFormation 스택을
# 삭제해도 되며, 그 경우 미래 백업만 중단되고 S3의 기존 백업 파일은 남는다.

usage() {
  cat <<'EOF'
사용법:
  ./deploy.sh --region ap-northeast-2 --bucket my-private-log-bucket \
    --sources-json ./log-sources.json [선택 옵션]

필수 옵션:
  --region REGION              AWS 리전
  --bucket BUCKET              기존의 비공개 S3 버킷
  --sources-json FILE          선택한 로그 그룹/스트림 JSON 파일

선택 옵션:
  --backup-prefix PREFIX       기본값: log-morning/daily
  --function-name NAME         기본값: log-morning-cloudwatch-backup
  --schedule-name NAME         기본값: log-morning-daily-0600-kst
  --stack-name NAME            기본값: log-morning-cloudwatch-backup
  --profile PROFILE            사용할 AWS CLI Profile 또는 SSO Profile

예시 JSON:
  [{"group":"/aws/lambda/example"},{"group":"/ecs/api","streams":["stream-a"]}]
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aws_region=""
backup_bucket=""
backup_prefix="log-morning/daily"
function_name="log-morning-cloudwatch-backup"
schedule_name="log-morning-daily-0600-kst"
stack_name="log-morning-cloudwatch-backup"
sources_file=""
aws_profile=""

while (( $# > 0 )); do
  case "$1" in
    --region) aws_region="${2:?--region 값이 필요합니다}"; shift 2 ;;
    --bucket) backup_bucket="${2:?--bucket 값이 필요합니다}"; shift 2 ;;
    --backup-prefix) backup_prefix="${2:?--backup-prefix 값이 필요합니다}"; shift 2 ;;
    --function-name) function_name="${2:?--function-name 값이 필요합니다}"; shift 2 ;;
    --schedule-name) schedule_name="${2:?--schedule-name 값이 필요합니다}"; shift 2 ;;
    --stack-name) stack_name="${2:?--stack-name 값이 필요합니다}"; shift 2 ;;
    --sources-json) sources_file="${2:?--sources-json 값이 필요합니다}"; shift 2 ;;
    --profile) aws_profile="${2:?--profile 값이 필요합니다}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '알 수 없는 옵션: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$aws_region" || -z "$backup_bucket" || -z "$sources_file" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -f "$sources_file" ]]; then
  printf '로그 소스 JSON 파일을 찾지 못했습니다: %s\n' "$sources_file" >&2
  exit 2
fi

command -v aws >/dev/null
command -v python3 >/dev/null
command -v zip >/dev/null
command -v shasum >/dev/null

aws_args=(--region "$aws_region")
if [[ -n "$aws_profile" ]]; then
  aws_args+=(--profile "$aws_profile")
fi

sources_json="$(python3 - "$sources_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source_file:
    sources = json.load(source_file)
if not isinstance(sources, list) or not sources:
    raise SystemExit("sources JSON must be a non-empty array")
for source in sources:
    if isinstance(source, str):
        continue
    if not isinstance(source, dict) or not isinstance(source.get("group"), str):
        raise SystemExit("each source must be a log group string or an object with a group field")
print(json.dumps(sources, ensure_ascii=False, separators=(",", ":")))
PY
)"

account_id="$(aws sts get-caller-identity "${aws_args[@]}" --query Account --output text)"
caller_arn="$(aws sts get-caller-identity "${aws_args[@]}" --query Arn --output text)"
partition="$(awk -F: '{print $2}' <<<"$caller_arn")"
log_group_arns_csv="$(python3 - "$sources_file" "$partition" "$aws_region" "$account_id" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source_file:
    sources = json.load(source_file)
groups = [item if isinstance(item, str) else item["group"] for item in sources]
print(",".join(f"arn:{sys.argv[2]}:logs:{sys.argv[3]}:{sys.argv[4]}:log-group:{group}:*" for group in groups))
PY
)"

build_dir="$(mktemp -d /tmp/log-morning-cloudwatch-backup.XXXXXX)"
cleanup() {
  if [[ -n "${build_dir:-}" && "$build_dir" == /tmp/log-morning-cloudwatch-backup.* ]]; then
    rm -rf "$build_dir"
  fi
}
trap cleanup EXIT

python3 -m py_compile "$script_dir/lambda_function.py"
zip_file="$build_dir/log-morning-cloudwatch-backup.zip"
zip -q -j "$zip_file" "$script_dir/lambda_function.py"
code_sha="$(shasum -a 256 "$zip_file" | awk '{print $1}')"
code_key="infrastructure/log-morning-cloudwatch-backup/lambda-${code_sha}.zip"

aws s3 cp "$zip_file" "s3://${backup_bucket}/${code_key}" \
  "${aws_args[@]}" --sse AES256 --only-show-errors

aws cloudformation validate-template \
  "${aws_args[@]}" --template-body "file://${script_dir}/template.yaml" >/dev/null

aws cloudformation deploy \
  "${aws_args[@]}" \
  --stack-name "$stack_name" \
  --template-file "$script_dir/template.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "BackupBucket=${backup_bucket}" \
    "BackupPrefix=${backup_prefix}" \
    "CodeS3Key=${code_key}" \
    "FunctionName=${function_name}" \
    "ScheduleName=${schedule_name}" \
    "LogSourcesJson=${sources_json}" \
    "LogGroupArnsCsv=${log_group_arns_csv}" \
  --tags \
    "Purpose=cloudwatch-daily-log-backup" \
    "CanDeleteWhenUnused=true" \
    "ManagedBy=CloudFormation" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks \
  "${aws_args[@]}" --stack-name "$stack_name" --query 'Stacks[0].Outputs' --output table
