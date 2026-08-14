# Log Morning CloudWatch 백업 Lambda

선택한 CloudWatch Logs를 매일 S3에 gzip JSONL로 백업하는 선택적 인프라입니다.

이 Lambda는 고객 요청이나 운영 비즈니스 로직을 처리하지 않습니다. 필요 없으면 CloudFormation 스택·스케줄·IAM 역할을 삭제해도 되며, 그 경우 미래 백업만 멈추고 기존 S3 파일은 유지됩니다.

## 배포

```bash
cp log-sources.example.json log-sources.json
# group과 streams를 현재 AWS 계정에 맞게 수정
./deploy.sh --region ap-northeast-2 --bucket my-private-log-bucket --sources-json log-sources.json
```

`streams`를 비워두면 로그 그룹 전체를 백업합니다. 정확한 스트림을 선택할 때는 한 로그 그룹당 최대 100개를 지정할 수 있습니다. CloudWatch에서 스트림 이름이 자주 바뀌는 ECS·Lambda 환경은 보통 그룹 전체 백업을 권장합니다.

데스크톱 앱을 쓰는 경우 설정 화면의 **배포용 JSON 저장** 버튼으로 같은 형식의 파일을
만들 수 있습니다. 실제 로그 그룹 이름이 담긴 `log-sources.json`은 공개 저장소에 커밋하지 마세요.

## 저장 형식

```text
s3://<bucket>/log-morning/daily/year=YYYY/month=MM/day=DD/window=0600KST/
  manifest.json
  _SUCCESS 또는 _LIVE
  raw/<로그-그룹-별칭>.jsonl.gz
  filtered/error.jsonl.gz
  filtered/warn.jsonl.gz
  filtered/business-failure.jsonl.gz
```

백업 구간은 현재 `Asia/Seoul` 기준 매일 06:00부터 다음 날 06:00까지입니다. 정기 작업은 최근 두 구간을 다시 읽어 늦게 수집된 CloudWatch 이벤트를 보완합니다.

## 안전과 비용

- Lambda 역할에는 선택한 로그 그룹의 `logs:FilterLogEvents`와 지정 S3 접두어의 쓰기 권한만 부여합니다.
- 일반적인 하루 1회 백업은 비용이 매우 작지만, CloudWatch 조회량·로그량·S3 보관 기간에 따라 달라집니다. 배포 전에 AWS 최신 요금표를 확인하세요.
- 이 템플릿은 기존 S3 버킷을 만들거나 삭제하지 않습니다.
