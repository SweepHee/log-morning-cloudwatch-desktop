use crate::aws_connection::{AwsSettings, normalized_daily_prefix, sdk_config};
use aws_sdk_cloudformation::Client as CloudFormationClient;
use aws_sdk_cloudformation::error::ProvideErrorMetadata;
use aws_sdk_cloudformation::types::{Capability, Parameter, Tag};
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_sts::Client as StsClient;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use zip::write::SimpleFileOptions;

const STACK_NAME: &str = "log-morning-cloudwatch-backup";
const SCHEDULE_NAME: &str = "log-morning-daily-0600-kst";
const TEMPLATE_BODY: &str = include_str!("../../infrastructure/cloudwatch-backup/template.yaml");
const LAMBDA_SOURCE: &str = include_str!("../../infrastructure/cloudwatch-backup/lambda_function.py");
const MAX_LOG_SOURCES_JSON_BYTES: usize = 3_500;
const MAX_STACK_WAIT_ATTEMPTS: usize = 200;

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfrastructureStatus {
    state: String,
    stack_name: String,
    stack_status: String,
    managed: bool,
    installed: bool,
    message: String,
}

impl BackupInfrastructureStatus {
    fn missing() -> Self {
        Self {
            state: "missing".to_owned(),
            stack_name: STACK_NAME.to_owned(),
            stack_status: String::new(),
            managed: false,
            installed: false,
            message: "아직 앱이 관리하는 백업 Lambda가 설치되지 않았습니다.".to_owned(),
        }
    }

    fn external(function_name: &str) -> Self {
        Self {
            state: "external".to_owned(),
            stack_name: STACK_NAME.to_owned(),
            stack_status: String::new(),
            managed: false,
            installed: true,
            message: format!(
                "{function_name} Lambda가 이미 존재하며 앱의 CloudFormation 스택 밖에서 관리됩니다. 중복 설치하지 않고 기존 함수를 사용합니다."
            ),
        }
    }

    fn from_stack_status(stack_status: &str) -> Self {
        let (state, installed, message) = classify_stack_status(stack_status);
        Self {
            state: state.to_owned(),
            stack_name: STACK_NAME.to_owned(),
            stack_status: stack_status.to_owned(),
            managed: true,
            installed,
            message: message.to_owned(),
        }
    }
}

fn classify_stack_status(status: &str) -> (&'static str, bool, &'static str) {
    if matches!(status, "CREATE_COMPLETE" | "UPDATE_COMPLETE" | "IMPORT_COMPLETE") {
        return ("ready", true, "백업 Lambda가 설치되어 있습니다. 다시 설치하면 같은 스택을 안전하게 업데이트합니다.");
    }
    if status.ends_with("_IN_PROGRESS") || status.ends_with("_CLEANUP_IN_PROGRESS") {
        return ("installing", false, "백업 인프라를 생성하거나 업데이트하고 있습니다.");
    }
    if status == "DELETE_COMPLETE" {
        return ("missing", false, "백업 인프라가 삭제되어 다시 설치할 수 있습니다.");
    }
    ("failed", false, "CloudFormation 스택 상태를 확인해야 합니다. 실패한 스택을 정리한 뒤 다시 설치하세요.")
}

fn parameter(key: &str, value: String) -> Parameter {
    Parameter::builder()
        .parameter_key(key)
        .parameter_value(value)
        .build()
}

fn stack_parameters(
    settings: &AwsSettings,
    code_key: &str,
    sources_json: &str,
    log_group_arns: &str,
) -> Result<Vec<Parameter>, String> {
    Ok(vec![
        parameter("BackupBucket", settings.bucket.trim().to_owned()),
        parameter(
            "BackupPrefix",
            normalized_daily_prefix(&settings.daily_prefix)?
                .trim_end_matches('/')
                .to_owned(),
        ),
        parameter("CodeS3Key", code_key.to_owned()),
        parameter("FunctionName", settings.lambda_function.trim().to_owned()),
        parameter("ScheduleName", SCHEDULE_NAME.to_owned()),
        parameter("LogSourcesJson", sources_json.to_owned()),
        parameter("LogGroupArnsCsv", log_group_arns.to_owned()),
    ])
}

fn log_sources_json(settings: &AwsSettings) -> Result<String, String> {
    if settings.log_groups.is_empty() {
        return Err("백업할 CloudWatch 로그 그룹을 하나 이상 선택하세요.".to_owned());
    }
    if settings.log_groups.len() > 100 {
        return Err("한 번에 백업할 수 있는 로그 그룹은 최대 100개입니다.".to_owned());
    }

    let sources: Vec<serde_json::Value> = settings
        .log_groups
        .iter()
        .map(|group| {
            let group = group.trim();
            if group.is_empty() || group.len() > 512 || group.contains([',', '\n', '\r', '\0']) {
                return Err("CloudWatch 로그 그룹 이름이 올바르지 않습니다.".to_owned());
            }
            let streams = settings.log_streams.get(group).cloned().unwrap_or_default();
            if streams.len() > 100 {
                return Err(format!("{group}에서 선택할 수 있는 로그 스트림은 최대 100개입니다."));
            }
            if streams.iter().any(|stream| {
                stream.trim().is_empty()
                    || stream.len() > 512
                    || stream.contains(['\n', '\r', '\0'])
            }) {
                return Err(format!("{group}의 로그 스트림 이름이 올바르지 않습니다."));
            }
            Ok(if streams.is_empty() {
                json!({ "group": group })
            } else {
                json!({ "group": group, "streams": streams })
            })
        })
        .collect::<Result<_, String>>()?;

    let serialized = serde_json::to_string(&sources)
        .map_err(|error| format!("로그 소스 설정을 만들지 못했습니다: {error}"))?;
    if serialized.len() > MAX_LOG_SOURCES_JSON_BYTES {
        return Err("선택한 로그 그룹·스트림 설정이 Lambda 환경 변수 한도를 넘습니다. 스트림 선택 수를 줄이거나 그룹 전체 백업을 사용하세요.".to_owned());
    }
    Ok(serialized)
}

fn lambda_zip() -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    archive
        .start_file("lambda_function.py", options)
        .map_err(|error| format!("Lambda 압축 파일을 시작하지 못했습니다: {error}"))?;
    archive
        .write_all(LAMBDA_SOURCE.as_bytes())
        .map_err(|error| format!("Lambda 압축 파일을 만들지 못했습니다: {error}"))?;
    archive
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| format!("Lambda 압축 파일을 완료하지 못했습니다: {error}"))
}

async fn describe_managed_stack(
    client: &CloudFormationClient,
) -> Result<Option<BackupInfrastructureStatus>, String> {
    match client.describe_stacks().stack_name(STACK_NAME).send().await {
        Ok(output) => {
            let stack = output
                .stacks()
                .first()
                .ok_or_else(|| "CloudFormation 스택 응답이 비어 있습니다.".to_owned())?;
            let status = stack
                .stack_status()
                .map(|value| value.as_str())
                .unwrap_or("UNKNOWN");
            Ok(Some(BackupInfrastructureStatus::from_stack_status(status)))
        }
        Err(error) => {
            let missing = error.as_service_error().is_some_and(|service_error| {
                service_error.code() == Some("ValidationError")
                    && service_error
                        .message()
                        .is_some_and(|message| message.contains("does not exist"))
            });
            if missing {
                Ok(None)
            } else {
                let detail = error
                    .as_service_error()
                    .and_then(|service_error| service_error.code())
                    .unwrap_or("알 수 없는 AWS 오류");
                Err(format!(
                    "CloudFormation 설치 상태를 확인하지 못했습니다. cloudformation:DescribeStacks 권한을 확인하세요: {detail}"
                ))
            }
        }
    }
}

async fn status_with_clients(
    settings: &AwsSettings,
    cloudformation: &CloudFormationClient,
    lambda: &LambdaClient,
) -> Result<BackupInfrastructureStatus, String> {
    if let Some(status) = describe_managed_stack(cloudformation).await? {
        return Ok(status);
    }
    match lambda
        .get_function()
        .function_name(settings.lambda_function.trim())
        .send()
        .await
    {
        Ok(_) => Ok(BackupInfrastructureStatus::external(
            settings.lambda_function.trim(),
        )),
        Err(error) => {
            let code = error
                .as_service_error()
                .and_then(|service_error| service_error.code());
            if code == Some("ResourceNotFoundException") {
                Ok(BackupInfrastructureStatus::missing())
            } else {
                Err(format!(
                    "같은 이름의 Lambda 존재 여부를 확인하지 못했습니다. lambda:GetFunction 권한을 확인하세요: {}",
                    code.unwrap_or("알 수 없는 AWS 오류")
                ))
            }
        }
    }
}

async fn wait_for_stack(
    client: &CloudFormationClient,
) -> Result<BackupInfrastructureStatus, String> {
    for _ in 0..MAX_STACK_WAIT_ATTEMPTS {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Some(status) = describe_managed_stack(client).await? else {
            continue;
        };
        if status.state == "ready" {
            return Ok(status);
        }
        if status.state == "failed" {
            return Err(format!(
                "CloudFormation 설치가 완료되지 않았습니다. 현재 상태: {}",
                status.stack_status
            ));
        }
    }
    Err("백업 인프라 설치가 10분 안에 끝나지 않았습니다. AWS CloudFormation에서 스택 상태를 확인하세요.".to_owned())
}

#[tauri::command]
pub async fn get_backup_infrastructure_status(
    settings: AwsSettings,
) -> Result<BackupInfrastructureStatus, String> {
    settings.validate_backup()?;
    let config = sdk_config(&settings).await?;
    status_with_clients(
        &settings,
        &CloudFormationClient::new(&config),
        &LambdaClient::new(&config),
    )
    .await
}

#[tauri::command]
pub async fn install_backup_infrastructure(
    settings: AwsSettings,
) -> Result<BackupInfrastructureStatus, String> {
    settings.validate_backup()?;
    let function_name = settings.lambda_function.trim();
    if !function_name
        .bytes()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err("Lambda 함수 이름에는 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.".to_owned());
    }
    let sources_json = log_sources_json(&settings)?;
    let _install_guard = INSTALL_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let config = sdk_config(&settings).await?;
    let cloudformation = CloudFormationClient::new(&config);
    let lambda = LambdaClient::new(&config);
    let initial_status = status_with_clients(&settings, &cloudformation, &lambda).await?;
    if initial_status.state == "external" {
        return Err(initial_status.message);
    }
    if initial_status.state == "failed" {
        return Err(format!(
            "기존 {} 스택 상태가 {}입니다. AWS CloudFormation에서 실패 원인을 확인하고 스택을 정리한 뒤 다시 시도하세요.",
            STACK_NAME, initial_status.stack_status
        ));
    }
    if initial_status.state == "installing" {
        wait_for_stack(&cloudformation).await?;
    }

    let identity = StsClient::new(&config)
        .get_caller_identity()
        .send()
        .await
        .map_err(|error| format!("AWS 계정 번호를 확인하지 못했습니다: {error}"))?;
    let account_id = identity
        .account()
        .ok_or_else(|| "AWS 계정 번호가 비어 있습니다.".to_owned())?;
    let partition = identity
        .arn()
        .and_then(|arn| arn.split(':').nth(1))
        .unwrap_or("aws");
    let log_group_arns = settings
        .log_groups
        .iter()
        .map(|group| {
            format!(
                "arn:{partition}:logs:{}:{account_id}:log-group:{}:*",
                settings.region.trim(),
                group.trim()
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    let zip_bytes = lambda_zip()?;
    let code_hash = hex::encode(Sha256::digest(&zip_bytes));
    let code_key = format!("infrastructure/log-morning-cloudwatch-backup/lambda-{code_hash}.zip");
    S3Client::new(&config)
        .put_object()
        .bucket(settings.bucket.trim())
        .key(&code_key)
        .body(ByteStream::from(zip_bytes))
        .content_type("application/zip")
        .send()
        .await
        .map_err(|error| format!("Lambda 코드를 S3에 업로드하지 못했습니다: {error}"))?;

    let parameters = stack_parameters(&settings, &code_key, &sources_json, &log_group_arns)?;
    let tags = vec![
        Tag::builder().key("Purpose").value("cloudwatch-daily-log-backup").build(),
        Tag::builder().key("CanDeleteWhenUnused").value("true").build(),
        Tag::builder().key("ManagedBy").value("LogMorningDesktop").build(),
    ];

    if initial_status.state == "missing" {
        match cloudformation
            .create_stack()
            .stack_name(STACK_NAME)
            .template_body(TEMPLATE_BODY)
            .set_parameters(Some(parameters))
            .capabilities(Capability::CapabilityIam)
            .set_tags(Some(tags))
            .send()
            .await
        {
            Ok(_) => {}
            Err(error) => {
                let code = error
                    .as_service_error()
                    .and_then(|service_error| service_error.code());
                if code != Some("AlreadyExistsException") {
                    return Err(format!(
                        "백업 CloudFormation 스택을 생성하지 못했습니다. CloudFormation·IAM·Lambda·Scheduler 생성 권한을 확인하세요: {}",
                        code.unwrap_or("알 수 없는 AWS 오류")
                    ));
                }
            }
        }
    } else {
        match cloudformation
            .update_stack()
            .stack_name(STACK_NAME)
            .template_body(TEMPLATE_BODY)
            .set_parameters(Some(parameters))
            .capabilities(Capability::CapabilityIam)
            .set_tags(Some(tags))
            .send()
            .await
        {
            Ok(_) => {}
            Err(error) => {
                let no_updates = error.as_service_error().is_some_and(|service_error| {
                    service_error.code() == Some("ValidationError")
                        && service_error
                            .message()
                            .is_some_and(|message| message.contains("No updates are to be performed"))
                });
                if no_updates {
                    return Ok(BackupInfrastructureStatus::from_stack_status("UPDATE_COMPLETE"));
                }
                let code = error
                    .as_service_error()
                    .and_then(|service_error| service_error.code())
                    .unwrap_or("알 수 없는 AWS 오류");
                return Err(format!("백업 CloudFormation 스택을 업데이트하지 못했습니다: {code}"));
            }
        }
    }

    wait_for_stack(&cloudformation).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aws_connection::AwsAuthMode;
    use std::collections::BTreeMap;

    fn settings() -> AwsSettings {
        AwsSettings {
            auth_mode: AwsAuthMode::Auto,
            profile: String::new(),
            region: "ap-northeast-2".to_owned(),
            bucket: "example-log-backup".to_owned(),
            daily_prefix: "log-morning/daily/".to_owned(),
            lambda_function: "log-morning-cloudwatch-backup".to_owned(),
            log_groups: vec!["/aws/lambda/example".to_owned()],
            log_streams: BTreeMap::new(),
        }
    }

    #[test]
    fn classifies_stack_states_for_idempotent_install() {
        assert_eq!("ready", classify_stack_status("CREATE_COMPLETE").0);
        assert_eq!("ready", classify_stack_status("UPDATE_COMPLETE").0);
        assert_eq!("installing", classify_stack_status("UPDATE_IN_PROGRESS").0);
        assert_eq!("failed", classify_stack_status("ROLLBACK_COMPLETE").0);
    }

    #[test]
    fn serializes_selected_groups_and_streams() {
        let mut settings = settings();
        settings.log_streams.insert(
            "/aws/lambda/example".to_owned(),
            vec!["2026/08/14/[$LATEST]example".to_owned()],
        );
        let serialized = log_sources_json(&settings).unwrap();
        assert!(serialized.contains("/aws/lambda/example"));
        assert!(serialized.contains("2026/08/14/[$LATEST]example"));
    }

    #[test]
    fn lambda_package_contains_handler_source() {
        let bytes = lambda_zip().unwrap();
        assert!(bytes.starts_with(b"PK"));
        assert!(bytes.len() > 1_000);
    }
}
