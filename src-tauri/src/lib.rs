mod aws_connection;
mod infrastructure;

use aws_connection::{
    AwsSettings, check_aws_connection, delete_access_key, get_credential_status, lambda_client,
    list_cloudwatch_log_groups, list_cloudwatch_log_streams, list_s3_buckets,
    normalized_daily_prefix, s3_client, save_access_key,
};
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_s3::Client as S3Client;
use chrono::{Duration as ChronoDuration, FixedOffset, NaiveDate, Timelike, Utc};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;
use infrastructure::{get_backup_infrastructure_status, install_backup_infrastructure};

const MAX_VISIBLE_DAYS: usize = 45;
const MAX_FILTER_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EVENTS_PER_FILTER: usize = 100_000;
const MAX_EXPORT_FILE_BYTES: usize = 200 * 1024 * 1024;
#[derive(Debug, Clone, Deserialize)]
struct ManifestCounts {
    #[serde(default)]
    total: usize,
    #[serde(default)]
    error: usize,
    #[serde(default)]
    warn: usize,
    #[serde(default)]
    business_failure: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    status: String,
    #[serde(default)]
    generated_at: String,
    window_start_kst: String,
    window_end_kst: String,
    counts: ManifestCounts,
    #[serde(default)]
    source_errors: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupDaySummary {
    date: String,
    prefix: String,
    status: String,
    generated_at: String,
    window_start_kst: String,
    window_end_kst: String,
    total: usize,
    error: usize,
    warn: usize,
    business_failure: usize,
    source_error_count: usize,
}

#[derive(Debug, Deserialize)]
struct LambdaWindowResult {
    s3_prefix: String,
}

#[derive(Debug, Deserialize)]
struct LambdaBackupResult {
    status: String,
    mode: String,
    windows: Vec<LambdaWindowResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentBackupRefresh {
    prefix: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFileResult {
    saved: bool,
    path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
// S3 JSONL은 Python Lambda가 snake_case로 기록하고, React에는 camelCase로 전달한다.
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct LogEvent {
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    ingestion_time: String,
    #[serde(default)]
    timestamp_ms: i64,
    #[serde(default)]
    ingestion_time_ms: i64,
    #[serde(default)]
    log_group: String,
    #[serde(default)]
    log_stream: Option<String>,
    #[serde(default)]
    event_id: Option<String>,
    #[serde(default)]
    level: String,
    #[serde(default)]
    business_failure: bool,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DayLogData {
    summary: BackupDaySummary,
    all: Vec<LogEvent>,
    errors: Vec<LogEvent>,
    warnings: Vec<LogEvent>,
    business_failures: Vec<LogEvent>,
}

fn validate_export_request(
    suggested_name: &str,
    extension: &str,
    contents: &str,
) -> Result<(), String> {
    if !matches!(extension, "txt" | "json") {
        return Err("TXT 또는 JSON 형식으로만 내보낼 수 있습니다.".to_owned());
    }
    if suggested_name.trim().is_empty()
        || suggested_name.len() > 180
        || suggested_name.contains('/')
        || suggested_name.contains('\\')
        || suggested_name.contains('\0')
    {
        return Err("내보내기 파일 이름이 올바르지 않습니다.".to_owned());
    }
    if contents.len() > MAX_EXPORT_FILE_BYTES {
        return Err("내보내기 파일이 200MB를 넘어 저장하지 않았습니다.".to_owned());
    }
    Ok(())
}

#[tauri::command]
async fn export_issue_file(
    app: tauri::AppHandle,
    suggested_name: String,
    extension: String,
    contents: String,
) -> Result<ExportFileResult, String> {
    validate_export_request(&suggested_name, &extension, &contents)?;

    let filter_name = if extension == "json" {
        "JSON 파일"
    } else {
        "텍스트 파일"
    };
    let selected = app
        .dialog()
        .file()
        .add_filter(filter_name, &[extension.as_str()])
        .set_file_name(&suggested_name)
        .blocking_save_file();

    let Some(selected) = selected else {
        return Ok(ExportFileResult {
            saved: false,
            path: None,
        });
    };

    let mut path = selected
        .into_path()
        .map_err(|error| format!("선택한 저장 경로를 사용할 수 없습니다: {error}"))?;
    if path.extension().and_then(|value| value.to_str()) != Some(extension.as_str()) {
        path.set_extension(&extension);
    }

    let write_path = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, contents.as_bytes()))
        .await
        .map_err(|error| format!("파일 저장 작업이 중단됐습니다: {error}"))?
        .map_err(|error| format!("내보내기 파일을 저장하지 못했습니다: {error}"))?;

    Ok(ExportFileResult {
        saved: true,
        path: Some(path.to_string_lossy().into_owned()),
    })
}

fn date_from_prefix(prefix: &str, daily_prefix: &str) -> Result<NaiveDate, String> {
    let normalized_prefix = normalized_daily_prefix(daily_prefix)?;
    let relative = prefix
        .strip_prefix(&normalized_prefix)
        .ok_or_else(|| {
            format!(
                "Lambda가 반환한 백업 경로({prefix})가 앱 설정의 S3 백업 경로({normalized_prefix})와 다릅니다. 설정에서 실제 Lambda의 BACKUP_PREFIX와 동일하게 맞추세요."
            )
        })?;
    if prefix.contains("..")
        || !relative.starts_with("year=")
        || !relative.ends_with("/window=0600KST")
    {
        return Err("허용되지 않은 백업 경로입니다.".to_owned());
    }

    let parts: Vec<&str> = relative.split('/').collect();
    if parts.len() != 4 || parts[3] != "window=0600KST" {
        return Err("백업 경로 형식이 올바르지 않습니다.".to_owned());
    }

    let year = parts[0]
        .strip_prefix("year=")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| "백업 연도가 올바르지 않습니다.".to_owned())?;
    let month = parts[1]
        .strip_prefix("month=")
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "백업 월이 올바르지 않습니다.".to_owned())?;
    let day = parts[2]
        .strip_prefix("day=")
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "백업 일이 올바르지 않습니다.".to_owned())?;

    NaiveDate::from_ymd_opt(year, month, day).ok_or_else(|| "존재하지 않는 백업 날짜입니다.".to_owned())
}

async fn get_object_bytes(client: &S3Client, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
    let output = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| format!("S3 객체를 읽지 못했습니다 ({key}): {error}"))?;

    if output.content_length().unwrap_or_default() > MAX_FILTER_FILE_BYTES as i64 {
        return Err(format!("안전을 위해 25MB보다 큰 필터 파일은 열지 않습니다: {key}"));
    }

    output
        .body
        .collect()
        .await
        .map(|body| body.into_bytes().to_vec())
        .map_err(|error| format!("S3 객체 다운로드가 중단됐습니다 ({key}): {error}"))
}

async fn read_manifest(client: &S3Client, bucket: &str, prefix: &str) -> Result<Manifest, String> {
    let bytes = get_object_bytes(client, bucket, &format!("{prefix}/manifest.json")).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("manifest.json 형식이 올바르지 않습니다: {error}"))
}

fn summary_from_manifest(
    prefix: &str,
    daily_prefix: &str,
    manifest: Manifest,
) -> Result<BackupDaySummary, String> {
    let date = date_from_prefix(prefix, daily_prefix)?
        .format("%Y-%m-%d")
        .to_string();
    Ok(BackupDaySummary {
        date,
        prefix: prefix.to_owned(),
        status: manifest.status,
        generated_at: manifest.generated_at,
        window_start_kst: manifest.window_start_kst,
        window_end_kst: manifest.window_end_kst,
        total: manifest.counts.total,
        error: manifest.counts.error,
        warn: manifest.counts.warn,
        business_failure: manifest.counts.business_failure,
        source_error_count: manifest.source_errors.len(),
    })
}

async fn read_jsonl_gzip(
    client: &S3Client,
    bucket: &str,
    key: &str,
) -> Result<Vec<LogEvent>, String> {
    let bytes = get_object_bytes(client, bucket, key).await?;
    let mut decoder = GzDecoder::new(bytes.as_slice());
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|error| format!("gzip 압축을 풀지 못했습니다 ({key}): {error}"))?;

    let reader = BufReader::new(decompressed.as_slice());
    let mut events = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        if events.len() >= MAX_EVENTS_PER_FILTER {
            return Err(format!("필터 하나에 {MAX_EVENTS_PER_FILTER}건을 초과하여 읽기를 중단했습니다."));
        }
        let line = line.map_err(|error| format!("로그 {index}번째 줄을 읽지 못했습니다: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<LogEvent>(&line)
            .map_err(|error| format!("로그 {}번째 줄의 JSON 형식이 올바르지 않습니다: {error}", index + 1))?;
        events.push(event);
    }
    Ok(events)
}

async fn read_all_raw(client: &S3Client, bucket: &str, prefix: &str) -> Result<Vec<LogEvent>, String> {
    let raw_prefix = format!("{prefix}/raw/");
    let mut continuation_token: Option<String> = None;
    let mut keys = Vec::new();

    loop {
        let mut request = client.list_objects_v2().bucket(bucket).prefix(&raw_prefix);
        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token);
        }
        let output = request
            .send()
            .await
            .map_err(|error| format!("원본 로그 파일 목록을 읽지 못했습니다: {error}"))?;
        keys.extend(
            output
                .contents()
                .iter()
                .filter_map(|object| object.key())
                .filter(|key| key.ends_with(".jsonl.gz"))
                .map(str::to_owned),
        );
        continuation_token = output.next_continuation_token().map(str::to_owned);
        if continuation_token.is_none() {
            break;
        }
    }
    if keys.is_empty() {
        return Err("선택한 날짜에 원본 JSONL 로그 파일이 없습니다.".to_owned());
    }
    keys.sort();

    let mut all = Vec::new();
    for key in keys {
        let mut events = read_jsonl_gzip(client, bucket, &key).await?;
        if all.len() + events.len() > MAX_EVENTS_PER_FILTER {
            return Err(format!(
                "하루 원본 로그가 {MAX_EVENTS_PER_FILTER}건을 초과하여 읽기를 중단했습니다."
            ));
        }
        all.append(&mut events);
    }
    Ok(all)
}

fn current_backup_prefix(now_utc: chrono::DateTime<Utc>, daily_prefix: &str) -> Result<String, String> {
    let kst = FixedOffset::east_opt(9 * 60 * 60).expect("KST offset must be valid");
    let now_kst = now_utc.with_timezone(&kst);
    let log_date = if now_kst.hour() < 6 {
        now_kst.date_naive() - ChronoDuration::days(1)
    } else {
        now_kst.date_naive()
    };
    Ok(format!(
        "{}year={:04}/month={:02}/day={:02}/window=0600KST",
        normalized_daily_prefix(daily_prefix)?,
        log_date.format("%Y"),
        log_date.format("%m"),
        log_date.format("%d")
    ))
}

async fn marker_exists(client: &S3Client, bucket: &str, prefix: &str, marker: &str) -> bool {
    client
        .head_object()
        .bucket(bucket)
        .key(format!("{prefix}/{marker}"))
        .send()
        .await
        .is_ok()
}

#[tauri::command]
async fn list_backup_days(settings: AwsSettings) -> Result<Vec<BackupDaySummary>, String> {
    settings.validate_backup()?;
    let client = s3_client(&settings).await?;
    let bucket = settings.bucket.trim();
    let daily_prefix = normalized_daily_prefix(&settings.daily_prefix)?;
    let mut continuation_token: Option<String> = None;
    let mut prefixes = BTreeSet::new();

    loop {
        let mut request = client.list_objects_v2().bucket(bucket).prefix(&daily_prefix);
        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token);
        }
        let output = request
            .send()
            .await
            .map_err(|error| format!("백업 날짜 목록을 읽지 못했습니다: {error}"))?;

        for object in output.contents() {
            let prefix = object.key().and_then(|key| {
                key.strip_suffix("/_SUCCESS")
                    .or_else(|| key.strip_suffix("/_LIVE"))
            });
            if let Some(prefix) =
                prefix.filter(|value| date_from_prefix(value, &settings.daily_prefix).is_ok())
            {
                prefixes.insert(prefix.to_owned());
            }
        }

        if output.is_truncated().unwrap_or(false) {
            continuation_token = output.next_continuation_token().map(str::to_owned);
        } else {
            break;
        }
    }

    let mut sorted_prefixes: Vec<String> = prefixes.into_iter().collect();
    sorted_prefixes.sort_by(|left, right| right.cmp(left));
    sorted_prefixes.truncate(MAX_VISIBLE_DAYS);

    let mut days = Vec::with_capacity(sorted_prefixes.len());
    for prefix in sorted_prefixes {
        let manifest = read_manifest(&client, bucket, &prefix).await?;
        days.push(summary_from_manifest(
            &prefix,
            &settings.daily_prefix,
            manifest,
        )?);
    }
    Ok(days)
}

#[tauri::command]
async fn load_backup_day(settings: AwsSettings, prefix: String) -> Result<DayLogData, String> {
    settings.validate_backup()?;
    date_from_prefix(&prefix, &settings.daily_prefix)?;
    let client = s3_client(&settings).await?;
    let bucket = settings.bucket.trim();

    if !marker_exists(&client, bucket, &prefix, "_SUCCESS").await
        && !marker_exists(&client, bucket, &prefix, "_LIVE").await
    {
        return Err("완료 또는 실시간 표시가 없는 백업은 안전하게 열 수 없습니다.".to_owned());
    }

    let manifest = read_manifest(&client, bucket, &prefix).await?;
    let summary = summary_from_manifest(&prefix, &settings.daily_prefix, manifest)?;
    // 원본은 로그 그룹별로 한 번만 읽는다. 전체 보기뿐 아니라 세 필터 화면도
    // 같은 레코드의 level/business_failure 값을 사용해 중복 다운로드 없이 만든다.
    let all = read_all_raw(&client, bucket, &prefix).await?;
    if all.len() != summary.total {
        return Err(format!(
            "원본 로그 수({})가 manifest 집계({})와 달라 안전하게 열 수 없습니다.",
            all.len(), summary.total
        ));
    }
    let errors = all.iter().filter(|event| event.level == "ERROR").cloned().collect();
    let warnings = all.iter().filter(|event| event.level == "WARN").cloned().collect();
    let business_failures = all
        .iter()
        .filter(|event| event.business_failure)
        .cloned()
        .collect();

    Ok(DayLogData {
        summary,
        all,
        errors,
        warnings,
        business_failures,
    })
}

#[tauri::command]
async fn refresh_current_backup(settings: AwsSettings) -> Result<CurrentBackupRefresh, String> {
    settings.validate_backup()?;
    let client = lambda_client(&settings).await?;
    let payload = Blob::new(br#"{"mode":"current","source":"log-morning-desktop"}"#.to_vec());
    let mut throttle_retries = 0_u16;

    // 예약 동시성이 1이므로 오전 6시 정기 백업이나 다른 사용자의 최신화가 진행 중이면
    // 짧게 기다린 뒤 다시 호출한다. 운영 서비스에는 요청하지 않고 백업 Lambda만 기다린다.
    let output = loop {
        match client
            .invoke()
            .function_name(settings.lambda_function.trim())
            .payload(payload.clone())
            .send()
            .await
        {
            Ok(output) => break output,
            Err(error) if error.to_string().contains("TooManyRequestsException") => {
                throttle_retries += 1;
                if throttle_retries >= 200 {
                    return Err(
                        "백업 Lambda가 10분 넘게 사용 중입니다. 잠시 후 다시 시도하세요.".to_owned(),
                    );
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(error) => {
                return Err(format!(
                    "오늘 로그 최신화를 시작하지 못했습니다. lambda:InvokeFunction 권한을 확인하세요: {error}"
                ));
            }
        }
    };

    let response_bytes = output
        .payload()
        .map(|value| value.as_ref())
        .ok_or_else(|| "백업 Lambda가 결과를 반환하지 않았습니다.".to_owned())?;
    if let Some(function_error) = output.function_error() {
        let detail = String::from_utf8_lossy(response_bytes);
        return Err(format!("오늘 로그 최신화가 실패했습니다 ({function_error}): {detail}"));
    }

    let response: LambdaBackupResult = serde_json::from_slice(response_bytes)
        .map_err(|error| format!("백업 Lambda 응답 형식이 올바르지 않습니다: {error}"))?;
    if response.mode != "current" || response.status != "complete" {
        return Err(format!(
            "백업 Lambda가 예상하지 못한 상태를 반환했습니다: mode={}, status={}",
            response.mode, response.status
        ));
    }
    let prefix = response
        .windows
        .first()
        .map(|window| window.s3_prefix.clone())
        .map(Ok)
        .unwrap_or_else(|| current_backup_prefix(Utc::now(), &settings.daily_prefix))?;

    Ok(CurrentBackupRefresh {
        prefix,
        status: "in_progress".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_extracts_backup_date() {
        let date = date_from_prefix(
            "log-morning/daily/year=2026/month=08/day=11/window=0600KST",
            "log-morning/daily/",
        )
        .unwrap();
        assert_eq!(date.format("%Y-%m-%d").to_string(), "2026-08-11");
    }

    #[test]
    fn rejects_arbitrary_s3_paths() {
        assert!(date_from_prefix("infrastructure/cloudwatch-daily-backup", "daily/").is_err());
        assert!(date_from_prefix("daily/../secret/window=0600KST", "daily/").is_err());
    }

    #[test]
    fn explains_mismatched_backup_prefix() {
        let error = date_from_prefix(
            "daily/year=2026/month=08/day=14/window=0600KST",
            "log-morning/daily/",
        )
        .unwrap_err();
        assert!(error.contains("daily/year=2026"));
        assert!(error.contains("log-morning/daily/"));
        assert!(error.contains("BACKUP_PREFIX"));
    }

    #[test]
    fn reads_lambda_snake_case_jsonl_fields() {
        let event: LogEvent = serde_json::from_str(
            r#"{"timestamp":"2026-08-11T07:00:00+09:00","timestamp_ms":1786400000000,"log_group":"/ecs/example-api-prod","business_failure":true,"message":"failed"}"#,
        )
        .unwrap();
        assert_eq!(event.timestamp_ms, 1_786_400_000_000);
        assert_eq!(event.log_group, "/ecs/example-api-prod");
        assert!(event.business_failure);
    }

    #[test]
    fn current_prefix_uses_six_am_log_day_boundary() {
        let before_six = chrono::DateTime::parse_from_rfc3339("2026-08-13T05:59:00+09:00")
            .unwrap()
            .with_timezone(&Utc);
        let after_six = chrono::DateTime::parse_from_rfc3339("2026-08-13T06:01:00+09:00")
            .unwrap()
            .with_timezone(&Utc);
        assert!(
            current_backup_prefix(before_six, "daily/")
                .unwrap()
                .contains("day=12")
        );
        assert!(
            current_backup_prefix(after_six, "daily/")
                .unwrap()
                .contains("day=13")
        );
    }

    #[test]
    fn export_request_allows_only_safe_file_names_and_supported_formats() {
        assert!(validate_export_request("log-morning.json", "json", "{}").is_ok());
        assert!(validate_export_request("../secret.txt", "txt", "log").is_err());
        assert!(validate_export_request("log.csv", "csv", "log").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_aws_connection,
            save_access_key,
            delete_access_key,
            get_credential_status,
            list_s3_buckets,
            list_cloudwatch_log_groups,
            list_cloudwatch_log_streams,
            get_backup_infrastructure_status,
            install_backup_infrastructure,
            list_backup_days,
            load_backup_day,
            refresh_current_backup,
            export_issue_file
        ])
        .run(tauri::generate_context!())
        .expect("로그 모닝 실행 중 오류가 발생했습니다.");
}
