use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::Credentials;
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_s3::Client as S3Client;
use aws_sdk_sts::Client as StsClient;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const KEYRING_SERVICE: &str = "app.logmorning.desktop.aws";
const KEYRING_USER: &str = "default";
const MAX_DISCOVERED_LOG_GROUPS: usize = 1_000;
const MAX_DISCOVERED_LOG_STREAMS: usize = 500;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AwsAuthMode {
    Auto,
    Profile,
    AccessKey,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsSettings {
    pub auth_mode: AwsAuthMode,
    #[serde(default)]
    pub profile: String,
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default = "default_daily_prefix")]
    pub daily_prefix: String,
    #[serde(default = "default_lambda_function")]
    pub lambda_function: String,
    #[serde(default)]
    pub log_groups: Vec<String>,
    #[serde(default)]
    pub log_streams: BTreeMap<String, Vec<String>>,
}

fn default_daily_prefix() -> String {
    "log-morning/daily/".to_owned()
}

fn default_lambda_function() -> String {
    "log-morning-cloudwatch-backup".to_owned()
}

impl AwsSettings {
    pub fn validate_auth(&self) -> Result<(), String> {
        let region = self.region.trim();
        if region.is_empty()
            || region.len() > 40
            || !region
                .bytes()
                .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
        {
            return Err("AWS 리전 형식이 올바르지 않습니다.".to_owned());
        }
        if self.auth_mode == AwsAuthMode::Profile && self.profile.trim().is_empty() {
            return Err("Profile/SSO 연결에는 AWS 프로필 이름이 필요합니다.".to_owned());
        }
        if self.profile.len() > 128 || self.profile.contains(['\n', '\r', '\0']) {
            return Err("AWS 프로필 이름이 올바르지 않습니다.".to_owned());
        }
        Ok(())
    }

    pub fn validate_backup(&self) -> Result<(), String> {
        self.validate_auth()?;
        let bucket = self.bucket.trim();
        if bucket.len() < 3
            || bucket.len() > 63
            || !bucket.bytes().all(|value| {
                value.is_ascii_lowercase()
                    || value.is_ascii_digit()
                    || value == b'-'
                    || value == b'.'
            })
        {
            return Err("S3 버킷 이름 형식이 올바르지 않습니다.".to_owned());
        }
        let prefix = normalized_daily_prefix(&self.daily_prefix)?;
        if prefix.len() > 300 {
            return Err("S3 백업 경로가 너무 깁니다.".to_owned());
        }
        if self.lambda_function.trim().is_empty() || self.lambda_function.len() > 140 {
            return Err("백업 Lambda 함수 이름이 올바르지 않습니다.".to_owned());
        }
        Ok(())
    }

    pub fn auth_label(&self) -> String {
        match self.auth_mode {
            AwsAuthMode::Auto => "자동 연결".to_owned(),
            AwsAuthMode::Profile => format!("{} profile", self.profile.trim()),
            AwsAuthMode::AccessKey => "보안 저장소 Access Key".to_owned(),
        }
    }
}

pub fn normalized_daily_prefix(prefix: &str) -> Result<String, String> {
    let trimmed = prefix.trim().trim_matches('/');
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains(['\n', '\r', '\0', '\\'])
    {
        return Err("S3 백업 경로가 올바르지 않습니다.".to_owned());
    }
    Ok(format!("{trimmed}/"))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccessKey {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessKeyInput {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: String,
}

impl AccessKeyInput {
    fn validate(&self) -> Result<(), String> {
        let access_key_id = self.access_key_id.trim();
        let secret_access_key = self.secret_access_key.trim();
        if !(16..=128).contains(&access_key_id.len())
            || access_key_id.bytes().any(|value| value.is_ascii_whitespace())
        {
            return Err("Access Key ID 형식이 올바르지 않습니다.".to_owned());
        }
        if !(16..=512).contains(&secret_access_key.len()) {
            return Err("Secret Access Key 형식이 올바르지 않습니다.".to_owned());
        }
        if self.session_token.len() > 8_192 {
            return Err("Session Token이 너무 깁니다.".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub stored: bool,
    pub access_key_hint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub bucket: String,
    pub region: String,
    pub profile: String,
    pub account_id: String,
    pub arn: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3BucketSummary {
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWatchLogGroupSummary {
    pub name: String,
    pub stored_bytes: i64,
    pub retention_days: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWatchLogStreamSummary {
    pub name: String,
    pub last_event_timestamp: Option<i64>,
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("운영체제 보안 저장소를 열지 못했습니다: {error}"))
}

fn load_stored_access_key() -> Result<StoredAccessKey, String> {
    let serialized = keyring_entry()?
        .get_password()
        .map_err(|error| match error {
            KeyringError::NoEntry => {
                "저장된 Access Key가 없습니다. 연결 설정에서 먼저 저장하세요.".to_owned()
            }
            other => format!("운영체제 보안 저장소에서 Access Key를 읽지 못했습니다: {other}"),
        })?;
    serde_json::from_str(&serialized).map_err(|_| {
        "보안 저장소의 Access Key 데이터가 손상되었습니다. 삭제 후 다시 저장하세요."
            .to_owned()
    })
}

#[tauri::command]
pub fn save_access_key(input: AccessKeyInput) -> Result<CredentialStatus, String> {
    input.validate()?;
    let stored = StoredAccessKey {
        access_key_id: input.access_key_id.trim().to_owned(),
        secret_access_key: input.secret_access_key.trim().to_owned(),
        session_token: input.session_token.trim().to_owned(),
    };
    let serialized = serde_json::to_string(&stored)
        .map_err(|error| format!("Access Key를 저장할 형식으로 만들지 못했습니다: {error}"))?;
    keyring_entry()?
        .set_password(&serialized)
        .map_err(|error| {
            format!("운영체제 보안 저장소에 Access Key를 저장하지 못했습니다: {error}")
        })?;
    Ok(CredentialStatus {
        stored: true,
        access_key_hint: access_key_hint(&stored.access_key_id),
    })
}

#[tauri::command]
pub fn delete_access_key() -> Result<CredentialStatus, String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(CredentialStatus {
            stored: false,
            access_key_hint: String::new(),
        }),
        Err(error) => Err(format!(
            "운영체제 보안 저장소의 Access Key를 삭제하지 못했습니다: {error}"
        )),
    }
}

#[tauri::command]
pub fn get_credential_status() -> Result<CredentialStatus, String> {
    match keyring_entry()?.get_password() {
        Ok(serialized) => {
            let stored: StoredAccessKey = serde_json::from_str(&serialized)
                .map_err(|_| "보안 저장소의 Access Key 데이터가 손상되었습니다.".to_owned())?;
            Ok(CredentialStatus {
                stored: true,
                access_key_hint: access_key_hint(&stored.access_key_id),
            })
        }
        Err(KeyringError::NoEntry) => Ok(CredentialStatus {
            stored: false,
            access_key_hint: String::new(),
        }),
        Err(error) => Err(format!("운영체제 보안 저장소를 확인하지 못했습니다: {error}")),
    }
}

fn access_key_hint(access_key_id: &str) -> String {
    let suffix: String = access_key_id
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("••••{suffix}")
}

pub async fn sdk_config(settings: &AwsSettings) -> Result<SdkConfig, String> {
    settings.validate_auth()?;
    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(settings.region.trim().to_owned()));

    match settings.auth_mode {
        AwsAuthMode::Auto => {}
        AwsAuthMode::Profile => {
            loader = loader.profile_name(settings.profile.trim().to_owned());
        }
        AwsAuthMode::AccessKey => {
            let stored = load_stored_access_key()?;
            let session_token = (!stored.session_token.is_empty()).then_some(stored.session_token);
            loader = loader.credentials_provider(Credentials::new(
                stored.access_key_id,
                stored.secret_access_key,
                session_token,
                None,
                "log-morning-os-keyring",
            ));
        }
    }

    Ok(loader.load().await)
}

pub async fn s3_client(settings: &AwsSettings) -> Result<S3Client, String> {
    Ok(S3Client::new(&sdk_config(settings).await?))
}

pub async fn lambda_client(settings: &AwsSettings) -> Result<LambdaClient, String> {
    Ok(LambdaClient::new(&sdk_config(settings).await?))
}

#[tauri::command]
pub async fn check_aws_connection(settings: AwsSettings) -> Result<ConnectionStatus, String> {
    settings.validate_auth()?;
    let config = sdk_config(&settings).await?;
    let identity = StsClient::new(&config)
        .get_caller_identity()
        .send()
        .await
        .map_err(|error| {
            format!("AWS 인증에 실패했습니다. 권한과 로그인 상태를 확인하세요: {error}")
        })?;

    if !settings.bucket.trim().is_empty() {
        S3Client::new(&config)
            .head_bucket()
            .bucket(settings.bucket.trim())
            .send()
            .await
            .map_err(|error| {
                format!("AWS 인증은 성공했지만 S3 버킷에 접근하지 못했습니다: {error}")
            })?;
    }

    Ok(ConnectionStatus {
        connected: true,
        bucket: settings.bucket.trim().to_owned(),
        region: settings.region.trim().to_owned(),
        profile: settings.auth_label(),
        account_id: identity.account().unwrap_or_default().to_owned(),
        arn: identity.arn().unwrap_or_default().to_owned(),
        message: "AWS 계정에 안전하게 연결되었습니다.".to_owned(),
    })
}

#[tauri::command]
pub async fn list_s3_buckets(settings: AwsSettings) -> Result<Vec<S3BucketSummary>, String> {
    let client = s3_client(&settings).await?;
    let output = client
        .list_buckets()
        .send()
        .await
        .map_err(|error| format!("S3 버킷 목록을 가져오지 못했습니다: {error}"))?;
    let mut buckets: Vec<S3BucketSummary> = output
        .buckets()
        .iter()
        .filter_map(|bucket| bucket.name())
        .map(|name| S3BucketSummary {
            name: name.to_owned(),
        })
        .collect();
    buckets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(buckets)
}

#[tauri::command]
pub async fn list_cloudwatch_log_groups(
    settings: AwsSettings,
) -> Result<Vec<CloudWatchLogGroupSummary>, String> {
    let client = CloudWatchLogsClient::new(&sdk_config(&settings).await?);
    let mut groups = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut request = client.describe_log_groups().limit(50);
        if let Some(token) = next_token.as_deref() {
            request = request.next_token(token);
        }
        let output = request
            .send()
            .await
            .map_err(|error| format!("CloudWatch 로그 그룹을 가져오지 못했습니다: {error}"))?;
        for group in output.log_groups() {
            if let Some(name) = group.log_group_name() {
                groups.push(CloudWatchLogGroupSummary {
                    name: name.to_owned(),
                    stored_bytes: group.stored_bytes().unwrap_or_default(),
                    retention_days: group.retention_in_days(),
                });
            }
            if groups.len() >= MAX_DISCOVERED_LOG_GROUPS {
                break;
            }
        }
        if groups.len() >= MAX_DISCOVERED_LOG_GROUPS {
            break;
        }
        next_token = output.next_token().map(str::to_owned);
        if next_token.is_none() {
            break;
        }
    }
    groups.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(groups)
}

#[tauri::command]
pub async fn list_cloudwatch_log_streams(
    settings: AwsSettings,
    log_group_name: String,
) -> Result<Vec<CloudWatchLogStreamSummary>, String> {
    if log_group_name.trim().is_empty() || log_group_name.len() > 512 {
        return Err("로그 그룹 이름이 올바르지 않습니다.".to_owned());
    }
    let client = CloudWatchLogsClient::new(&sdk_config(&settings).await?);
    let mut streams = Vec::new();
    let mut next_token: Option<String> = None;

    loop {
        let mut request = client
            .describe_log_streams()
            .log_group_name(log_group_name.trim())
            .limit(50);
        if let Some(token) = next_token.as_deref() {
            request = request.next_token(token);
        }
        let output = request
            .send()
            .await
            .map_err(|error| format!("CloudWatch 로그 스트림을 가져오지 못했습니다: {error}"))?;
        for stream in output.log_streams() {
            if let Some(name) = stream.log_stream_name() {
                streams.push(CloudWatchLogStreamSummary {
                    name: name.to_owned(),
                    last_event_timestamp: stream.last_event_timestamp(),
                });
            }
            if streams.len() >= MAX_DISCOVERED_LOG_STREAMS {
                break;
            }
        }
        if streams.len() >= MAX_DISCOVERED_LOG_STREAMS {
            break;
        }
        next_token = output.next_token().map(str::to_owned);
        if next_token.is_none() {
            break;
        }
    }
    streams.sort_by(|left, right| {
        right
            .last_event_timestamp
            .cmp(&left.last_event_timestamp)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(streams)
}
